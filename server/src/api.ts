/**
 * As rotas HTTP que pertencem ao servidor.
 *
 * O critério do que fica aqui e do que vai para o `app/` é um só: toca o
 * estado em memória das salas, ou toca um segredo. O espelho de avatar não faz
 * nem uma coisa nem outra — e manter 200 imagens em cache dentro do processo
 * que faz relay de vídeo é disputar memória com o backpressure dos sockets —,
 * então ele é rota do Next. O clientId chega ao navegador pelo HTML que o app
 * renderiza, sem uma ida à rede para descobri-lo.
 *
 * O contrato é o de `.claude/specs/09-protocolo.md`: nomes de campo e de rota são
 * herdados e não mudam.
 */
import crypto from 'node:crypto';

import { fail, json, redirect } from './http.ts';
import type { Context, Handler } from './http.ts';
import { clientIp, hit } from './limits.ts';
import { sign, verify } from './tokens.ts';
import * as rooms from './rooms.ts';
import * as discord from './discord.ts';
import {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  PUBLIC_ORIGIN,
  REDIRECT_URI,
  WEB_INSTANCE,
  isProd,
} from './config.ts';
import type { Claims } from './types.ts';

// ---------------------------------------------------------------- identidade

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function issueIdentity(
  instance: string,
  uid: string,
  name: string,
  avatar: string | null,
  ttl = 8 * 60 * 60,
  extra: Partial<Claims> = {}
) {
  return {
    user: { id: uid, name, avatar },
    instance,
    identity: sign({ instance, uid, name, av: avatar, scope: 'identity', ...extra }, ttl),
  };
}

/**
 * Freio por endereço. Responde 429 e devolve true quando estourou.
 *
 * Toda rota que cria estado em memória (sala, convidado) ou gasta CPU (hash de
 * senha) passa por aqui: sem isto, um laço de requisições vira RAM e CPU do
 * mesmo processo que faz o relay de vídeo.
 */
function limited(ctx: Context, bucket: string, max: number, windowMs: number): boolean {
  const wait = hit(`${bucket}:${clientIp(ctx.req)}`, max, windowMs);
  if (wait === null) return false;
  ctx.res.setHeader('Retry-After', String(wait));
  fail(ctx.res, 429, `Muitas tentativas. Tente de novo em ${wait}s.`, { retryAfter: wait });
  return true;
}

/** Valida o token de identidade que acompanha toda operação de sala. */
function identityOf(ctx: Context): Claims | null {
  const claims = verify(ctx.body.identity);
  if (!claims || claims.scope !== 'identity') {
    fail(ctx.res, 401, 'identidade invalida ou expirada');
    return null;
  }
  return claims;
}

/**
 * Tokens de acesso a uma sala, emitidos depois de passar pela senha.
 *
 * Com prazo (12 h): o id da sala de uma call é derivado do canal, então ele
 * se repete quando a sala é recriada — sem prazo, um token antigo (de quem foi
 * expulso da call, ou vazado num log) abriria a sala para sempre. 12 h cobre
 * qualquer sessão real; depois disso basta reabrir a atividade.
 *
 * O shareUrl aponta para /share, servido pelo app — a página de captura
 * precisa abrir fora do iframe do Discord, e é o PUBLIC_ORIGIN que garante
 * isso. Ele é o endereço da porta de entrada, não o deste processo.
 */
const ROOM_TOKEN_TTL = 12 * 60 * 60;

function roomTokens(roomId: string, me: Claims) {
  const base = { room: roomId, uid: me.uid, name: me.name, av: me.av ?? null };
  return {
    roomId,
    viewerToken: sign({ ...base, role: 'viewer' }, ROOM_TOKEN_TTL),
    shareUrl: `${PUBLIC_ORIGIN}/share?t=${encodeURIComponent(sign({ ...base, role: 'broadcaster' }, ROOM_TOKEN_TTL))}`,
  };
}

/**
 * A sala desta call. É a única sala que existe dentro do Discord: a atividade
 * abre nela direto, sem lista, porque escolher entre uma opção só não é escolha.
 */
const callRoomId = (me: Claims) =>
  me.call ? `call-${me.call}` : `atividade-${me.instance ?? WEB_INSTANCE}`;

const instanceOf = (me: Claims) => me.instance ?? WEB_INSTANCE;

// --------------------------------------------------------------------- OAuth

const exchangeToken: Handler = async ({ res, body }) => {
  const code = str(body.code);
  const clientId = str(body.client_id);
  if (!code) return fail(res, 400, 'code obrigatorio');

  // A metade que autoriza é a aplicação que abriu a atividade; a metade que
  // troca o código é este servidor. Se forem aplicações diferentes, o Discord
  // recusa — e o erro dele não diz qual das duas está errada.
  if (clientId && DISCORD_CLIENT_ID && clientId !== DISCORD_CLIENT_ID) {
    console.error(`[oauth] atividade e da aplicacao ${clientId}, mas o .env tem ${DISCORD_CLIENT_ID}`);
    return fail(
      res,
      409,
      `Esta atividade é da aplicação ${clientId}, mas o servidor está configurado ` +
        `com a ${DISCORD_CLIENT_ID}. As duas precisam ser a mesma.`
    );
  }

  // Sem credencial não há troca possível, e o erro que o Discord devolve nesse
  // caso não deixa isso óbvio para ninguém. Dizer aqui poupa a caçada.
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    console.error('[oauth] DISCORD_CLIENT_ID ou DISCORD_CLIENT_SECRET ausente no .env');
    return fail(res, 500, 'O servidor está sem as credenciais do Discord. Configure o .env.');
  }

  const accessToken = await discord.exchangeCode(code, REDIRECT_URI);
  if (!accessToken) return fail(res, 502, 'o Discord recusou a troca do codigo');

  json(res, 200, { access_token: accessToken });
};

const session: Handler = async (ctx) => {
  const { res, body } = ctx;
  if (limited(ctx, 'session', 30, 60_000)) return;

  const accessToken = str(body.access_token);
  const instanceId = str(body.instance_id);
  if (!accessToken || !instanceId || instanceId.length > 128) {
    return fail(res, 400, 'access_token e instance_id obrigatorios');
  }

  // Só token emitido para ESTA aplicação abre sessão.
  const me = await discord.authorizedProfile(accessToken);
  if (!me) return fail(res, 401, 'token invalido');

  // Com o bot configurado, o Discord confirma que a pessoa está na instância
  // que ela alega. Sem bot, o id da instância vale pelo próprio segredo.
  if ((await discord.inActivityInstance(instanceId, me.id)) === 'out') {
    return fail(res, 403, 'Abra a atividade pela call antes de entrar.');
  }

  const channelId = str(body.channel_id);
  const presence = await discord.inVoiceChannel(str(body.guild_id), channelId, me.id);
  if (presence === 'out') {
    return fail(res, 403, 'Entre na call antes de abrir a atividade.');
  }

  // O canal entra no token assinado, não fica só na resposta: é o que permite
  // ao endpoint da sala da call confiar sem consultar o Discord de novo.
  const guildId = str(body.guild_id);
  const confirmed =
    presence === 'in' && channelId
      ? { call: channelId, ...(guildId ? { guild: guildId } : {}) }
      : {};
  const identity = issueIdentity(instanceId, me.id, me.name, me.avatar, 8 * 60 * 60, confirmed);

  json(res, 200, { ...identity, call: presence === 'in' ? channelId : null });
};

/**
 * Identidade de teste com instância à escolha. Fora do ar em produção: poder
 * escolher a instância permitiria espiar as salas de qualquer canal de voz.
 */
const devSession: Handler = ({ res, body }) => {
  if (isProd) return fail(res, 404, 'rota inexistente');
  const instance = str(body.instance_id) ?? 'dev';
  const name = str(body.name) ?? 'Dev';
  const call = str(body.call);
  json(res, 200, issueIdentity(instance, `dev-${name}`, name, null, 8 * 60 * 60, call ? { call } : {}));
};

/**
 * Identidade de convidado: entra sem conta.
 *
 * O login do Discord é uma melhoria opcional, não um pedágio — exigir conta só
 * para assistir uma tela afastaria justamente quem recebeu um link.
 *
 * Validade longa de propósito: o id do convidado é o que amarra a posse das
 * salas que ele criou, e perder isso no meio do uso seria pior que o risco de
 * um token de convidado antigo, que não dá acesso a nada além do lobby público.
 */
const guestSession: Handler = (ctx) => {
  const { res, body } = ctx;
  // Convidado é de graça e cada um pode criar salas: o teto é por endereço.
  if (limited(ctx, 'guest', 20, 10 * 60_000)) return;

  // str(), e não String(): o corpo vem de fora e `name` pode ser objeto —
  // String({}) viraria o nome "[object Object]" em vez de cair no padrão.
  const raw = (str(body.name) ?? '').replace(/\s+/g, ' ').trim().slice(0, 32);
  const name = raw || `Convidado ${Math.floor(Math.random() * 9000 + 1000)}`;
  const uid = `guest-${crypto.randomBytes(8).toString('base64url')}`;
  json(res, 200, issueIdentity(WEB_INSTANCE, uid, name, null, 30 * 24 * 60 * 60));
};

// --------------------------------------------------------------------- salas

/**
 * Listar não exige login: dá para ver o lobby antes de entrar.
 *
 * Criar e entrar continuam exigindo identidade — sem isso não haveria dono de
 * sala nem nome de participante.
 */
const list: Handler = ({ res, body }) => {
  const me = verify(body.identity);
  const instance = me?.scope === 'identity' ? instanceOf(me) : WEB_INSTANCE;
  json(res, 200, { rooms: rooms.listRooms(instance) });
};

const create: Handler = async (ctx) => {
  if (limited(ctx, 'create', 10, 60_000)) return;
  const me = identityOf(ctx);
  if (!me) return;

  const result = await rooms.createRoom({
    instance: instanceOf(me),
    name: str(ctx.body.name),
    ownerId: me.uid,
    ownerName: me.name,
    password: str(ctx.body.password) ?? null,
  });
  if ('error' in result) return fail(ctx.res, 400, result.error);

  console.log(`[room ${result.room.id}] criada por ${me.name}: "${result.room.name}"`);
  json(ctx.res, 200, roomTokens(result.room.id, me));
};

/**
 * A sala de um canal de voz, alcançada por `/<id do servidor>`.
 *
 * Um servidor tem **N salas**, uma por canal de voz — por isso o endereço
 * aceita `?room=`, que diz qual. Sem ele, vale a call em que a pessoa está
 * agora.
 *
 * O `room` **não é credencial**. Ele vai ser colado em convite, e quem receber
 * o link só entra se estiver naquela call: é a presença que autoriza, como na
 * Activity (RN-SAL-4). Um link compartilhado para quem está fora não abre nada.
 *
 * Aqui não há `channel_id` vindo do cliente, então quem diz em qual call a
 * pessoa está é o Discord. E estas salas seguem invisíveis para quem chega pela
 * raiz: são `isCall`, e `listRooms` não lista `isCall` (RN-SAL-5).
 *
 * Convidado não entra: sem conta do Discord não há voz para consultar.
 */
const guildRoom: Handler = async (ctx) => {
  const me = identityOf(ctx);
  if (!me) return;

  const guildId = str(ctx.body.guild_id);
  if (!guildId || !/^[0-9]{15,21}$/.test(guildId)) {
    return fail(ctx.res, 400, 'servidor invalido');
  }

  if (me.uid.startsWith('guest-')) {
    return fail(ctx.res, 401, 'Entre com o Discord para usar o link do servidor.');
  }

  const voice = await discord.voiceChannelOf(guildId, me.uid);

  if (voice.type === 'unknown') {
    return fail(
      ctx.res,
      503,
      'Não consigo enxergar as calls deste servidor. Adicione o bot ao servidor, ' +
        'ou dê a ele permissão de ver o seu canal de voz.'
    );
  }
  if (voice.type === 'out') {
    return fail(ctx.res, 403, 'Você não está em nenhuma call deste servidor. Entre num canal de voz e tente de novo.');
  }

  const myCallRoom = `call-${voice.channel}`;
  const requested = str(ctx.body.room);

  // Veio um link de convite apontando para outra call. Recusar é o ponto:
  // quem autoriza é estar lá, não ter o endereço.
  if (requested && requested !== myCallRoom) {
    // O `code` deixa o cliente distinguir esta recusa das outras: aqui a pessoa
    // **está** numa call, só que noutra — então cabe oferecer a dela, em vez de
    // pedir que entre em alguma.
    return fail(
      ctx.res,
      403,
      'Esse link é de outra call.',
      { code: 'outra-call' }
    );
  }

  // A instância é o servidor, e o id da sala é o canal (RN-SAL-3): a call é
  // estável, e é ela que define quem pode ver a tela de quem.
  //
  // O nome vem do próprio canal — "Categoria / Canal" — para a pessoa
  // reconhecer de qual call se trata sem precisar decorar id nenhum.
  const name = await discord.channelName(guildId, voice.channel);
  const room = rooms.ensureCallRoom(`guild-${guildId}`, myCallRoom, name);

  // Como a pessoa se chama **neste servidor**. Se ela já escolheu um apelido
  // no produto, ele manda: é escolha dela, e sobrescrevê-la a cada entrada
  // faria o nome voltar sozinho (RN-SES-13).
  const guildNickname = await discord.memberName(guildId, me.uid);
  const eu: Claims = guildNickname ? { ...me, name: guildNickname } : me;

  json(ctx.res, 200, {
    ...roomTokens(room.id, eu),
    roomName: room.name,
    user: { id: eu.uid, name: eu.name, avatar: eu.av ?? null },
  });
};

const callRoom: Handler = async (ctx) => {
  const me = identityOf(ctx);
  if (!me) return;

  // O nome vem do canal quando dá para saber qual é: o crachá da Activity
  // carrega o servidor e o canal desde que a presença foi confirmada. Sem
  // confirmação não há canal, e aí fica o nome genérico.
  const name = me.guild && me.call ? await discord.channelName(me.guild, me.call) : null;

  const room = rooms.ensureCallRoom(instanceOf(me), callRoomId(me), name);
  json(ctx.res, 200, roomTokens(room.id, me));
};

const join: Handler = async (ctx) => {
  if (limited(ctx, 'join', 30, 60_000)) return;
  const me = identityOf(ctx);
  if (!me) return;

  const room = rooms.getRoom(ctx.body.roomId);
  if (!room) return fail(ctx.res, 404, 'Sala não existe mais.');

  // A sala da call é avaliada antes da instância: quem manda nela é a presença
  // no canal, confirmada pelo Discord. Checar instância aqui recusaria por
  // motivo errado, já que o id dela vem do canal e não da instância.
  if (room.isCall) {
    if (room.id !== callRoomId(me)) {
      return fail(ctx.res, 403, 'Entre na call para acessar esta sala.');
    }
    return json(ctx.res, 200, roomTokens(room.id, me));
  }

  // Salas comuns: as de um canal de voz não aparecem nem abrem em outro.
  if (room.instance !== instanceOf(me)) return fail(ctx.res, 404, 'Sala não existe mais.');

  const verdict = await rooms.checkPassword(room, me.uid, str(ctx.body.password));
  if (!verdict.ok) {
    const locked = verdict.reason === 'locked';
    return fail(
      ctx.res,
      locked ? 429 : 403,
      locked
        ? `Muitas tentativas. Tente de novo em ${verdict.seconds}s.`
        : 'Senha incorreta.',
      { reason: verdict.reason }
    );
  }

  json(ctx.res, 200, roomTokens(room.id, me));
};

const password: Handler = async (ctx) => {
  if (limited(ctx, 'password', 10, 60_000)) return;
  const me = identityOf(ctx);
  if (!me) return;

  const room = rooms.getRoom(ctx.body.roomId);
  if (!room || room.instance !== instanceOf(me)) {
    return fail(ctx.res, 404, 'Sala não existe mais.');
  }

  const error = await rooms.setPassword(room, me.uid, str(ctx.body.password) ?? null);
  if (error) return fail(ctx.res, 403, error);

  json(ctx.res, 200, { ok: true, locked: Boolean(room.password) });
};

// -------------------------------------------- login web (fora do Discord)

/**
 * Só caminho local, e só o que este produto tem.
 *
 * O `goBack` vem da query, então ele é entrada de fora: sem esta guarda o
 * endereço de login vira um redirecionador aberto — alguém manda
 * `/auth/login?goBack=https://outro.site` e o Discord devolve a pessoa lá,
 * carimbada de "veio do login do Discord".
 */
function safeRedirect(raw: string | null): string {
  if (!raw) return '/';
  // Só a raiz ou /<id de servidor>. Nada de "//" nem de esquema.
  return /^\/[0-9]{0,21}$/.test(raw) ? raw : '/';
}

/**
 * O `state` do OAuth carrega um nonce amarrado a este navegador por cookie.
 *
 * Sem isto, alguém inicia o login com a própria conta, para no callback e
 * manda o link para a vítima: o navegador dela termina o fluxo e passa a operar
 * com a identidade do atacante (login CSRF). Com o nonce, o callback só aceita
 * o fluxo que este mesmo navegador começou.
 */
const STATE_COOKIE = 'sdt_oauth_state';

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=') || null;
  }
  return null;
}

function stateCookie(value: string, maxAge: number): string {
  const secure = PUBLIC_ORIGIN.startsWith('https://') ? '; Secure' : '';
  return `${STATE_COOKIE}=${value}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

const login: Handler = ({ res, query }) => {
  const url = discord.loginUrl(REDIRECT_URI);
  if (!url) return fail(res, 503, 'login do Discord nao configurado');

  // Para onde voltar depois. Vai no `state` do OAuth, junto do nonce.
  const nonce = crypto.randomBytes(16).toString('base64url');
  const target = new URL(url);
  target.searchParams.set('state', `${nonce}.${safeRedirect(query.get('goBack'))}`);
  res.setHeader('Set-Cookie', stateCookie(nonce, 600));
  redirect(res, target.toString());
};

const callback: Handler = async ({ req, res, query }) => {
  const rawState = query.get('state') ?? '';
  const cut = rawState.indexOf('.');
  const nonce = cut > 0 ? rawState.slice(0, cut) : '';
  const expected = readCookie(req.headers.cookie, STATE_COOKIE);
  res.setHeader('Set-Cookie', stateCookie('', 0));
  if (
    !nonce ||
    !expected ||
    nonce.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(nonce), Buffer.from(expected))
  ) {
    return redirect(res, '/?error=state_mismatch');
  }

  const code = query.get('code');
  if (!code) return redirect(res, '/?error=missing_code');

  const accessToken = await discord.exchangeCode(code, REDIRECT_URI);
  if (!accessToken) return redirect(res, '/?error=exchange_failed');

  const me = await discord.authorizedProfile(accessToken);
  if (!me) return redirect(res, '/?error=profile_failed');

  // 30 dias, como o crachá de convidado. Com 8 horas a pessoa reencontrava a
  // tela de consentimento do Discord quase todo dia, e autorizar de novo o que
  // já se autorizou lê como se algo tivesse dado errado.
  const { identity } = issueIdentity(WEB_INSTANCE, me.id, me.name, me.avatar, 30 * 24 * 60 * 60);

  // O `state` volta intacto do Discord, mas ele passou por fora — então é
  // conferido de novo aqui, não só na ida.
  const back = safeRedirect(cut > 0 ? rawState.slice(cut + 1) : null);

  // No fragmento, não na query: o fragmento não é enviado ao servidor nem
  // aparece em log de proxy. O cliente lê e limpa da barra de endereço.
  // Marca de "este navegador acabou de fazer login": o cliente só aceita um
  // crachá no fragmento se ela estiver presente. Sem isto, um link
  // `/#identity=<crachá do atacante>` colava a identidade dele em quem abrisse.
  const secure = PUBLIC_ORIGIN.startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    stateCookie('', 0),
    `sdt_login_ok=1; Path=/; SameSite=Lax; Max-Age=120${secure}`,
  ]);
  redirect(res, `${back}#identity=${encodeURIComponent(identity)}`);
};

// -------------------------------------------------------------------- tabela

export const routes: Record<string, Handler> = {
  'POST /api/token': exchangeToken,
  'POST /api/session': session,
  'POST /api/session-dev': devSession,
  'POST /api/session-guest': guestSession,

  'POST /api/rooms/list': list,
  'POST /api/rooms/create': create,
  'POST /api/rooms/call': callRoom,
  'POST /api/rooms/guild': guildRoom,
  'POST /api/rooms/join': join,
  'POST /api/rooms/password': password,

  'GET /auth/login': login,
  'GET /auth/callback': callback,

  // Responder 200 aqui prova que servidor e relay estão de pé. Só isso: a
  // lista de salas saía nesta rota pública e entregava o id de toda instância
  // da Activity — com ele, qualquer pessoa entrava na call de outro grupo.
  'GET /api/health': ({ res }) => json(res, 200, { ok: true }),
};
