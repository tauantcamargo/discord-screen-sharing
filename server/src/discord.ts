/**
 * Tudo que fala com a API do Discord.
 *
 * Junto num arquivo porque é aqui que moram os dois segredos — o da aplicação
 * e o do bot. Concentrá-los deixa óbvio, de fora, o que não pode sair deste
 * processo: nada disto tem versão no `app/`.
 */
import { DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET } from './config.ts';
import type { Person } from './types.ts';

const API = 'https://discord.com/api';

/** Troca o code do OAuth pelo access_token. O secret nunca sai daqui. */
export async function exchangeCode(code: string, redirectUri: string): Promise<string | null> {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) return null;

  const r = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    }),
  });

  const data = (await r.json().catch(() => null)) as { access_token?: string } | null;
  return data?.access_token ?? null;
}

/** Perfil de quem autorizou. @returns null se o token não vale mais. */
export async function profileOf(accessToken: string): Promise<Person | null> {
  const me = (await fetch(`${API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
    .then((r) => r.json())
    .catch(() => null)) as { id?: string; global_name?: string; username?: string; avatar?: string | null } | null;

  if (!me?.id) return null;
  return { id: me.id, name: me.global_name || me.username || me.id, avatar: me.avatar ?? null };
}

/**
 * Perfil de quem autorizou **esta** aplicação.
 *
 * `/users/@me` aceita access_token de qualquer aplicação do Discord: um token
 * emitido para outro app abriria sessão aqui. `/oauth2/@me` diz para qual
 * aplicação o token foi emitido, e a sessão só vale se for a nossa.
 *
 * @returns null se o token não vale ou é de outra aplicação.
 */
export async function authorizedProfile(accessToken: string): Promise<Person | null> {
  if (!DISCORD_CLIENT_ID) return profileOf(accessToken);

  const info = (await fetch(`${API}/oauth2/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as {
    application?: { id?: string };
    user?: { id?: string; global_name?: string | null; username?: string; avatar?: string | null };
  } | null;

  if (!info?.user?.id) return null;
  if (info.application?.id !== DISCORD_CLIENT_ID) {
    console.warn('[oauth] access_token de outra aplicacao recusado');
    return null;
  }

  const u = info.user;
  return { id: u.id as string, name: u.global_name || u.username || (u.id as string), avatar: u.avatar ?? null };
}

/**
 * A pessoa está mesmo nesta instância da Activity?
 *
 * O `instance_id` vem do cliente. Com o token do bot dá para perguntar ao
 * Discord quem está na instância; sem ele a resposta é 'unknown' e a
 * instância vale só pelo segredo do próprio id (que nunca é exposto).
 */
export async function inActivityInstance(instanceId: string, userId: string): Promise<Presence> {
  if (!DISCORD_BOT_TOKEN || !DISCORD_CLIENT_ID) return 'unknown';
  try {
    const r = await fetch(
      `${API}/v10/applications/${DISCORD_CLIENT_ID}/activity-instances/${encodeURIComponent(instanceId)}`,
      { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }, signal: AbortSignal.timeout(10_000) }
    );
    // 404 = instância que não existe: quem inventou um id cai numa sala só
    // dele, sem ninguém dentro. Recusar aqui só trancaria gente por falha nossa.
    if (!r.ok) return 'unknown';
    const data = (await r.json()) as { users?: string[] };
    if (!Array.isArray(data.users)) return 'unknown';
    return data.users.includes(userId) ? 'in' : 'out';
  } catch {
    return 'unknown';
  }
}

export function loginUrl(redirectUri: string): string | null {
  if (!DISCORD_CLIENT_ID) return null;
  const url = new URL(`${API}/oauth2/authorize`);
  url.searchParams.set('client_id', DISCORD_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify');
  return url.toString();
}

/**
 * O nome da sala, montado a partir do canal de voz.
 *
 * `Categoria / Canal` quando o canal está numa categoria, só `Canal` quando
 * não está — que é como o Discord mostra na barra lateral, e é assim que a
 * pessoa reconhece de qual call se trata.
 *
 * Uma chamada só: a lista de canais do servidor traz o canal e a categoria
 * dele juntos, e buscar os dois separadamente dobraria a ida à API do Discord
 * numa hora em que alguém está esperando a sala abrir.
 *
 * @returns null quando não dá para saber — aí quem chama fica com o nome
 *   genérico, que é melhor do que uma sala chamada "undefined".
 */
export async function channelName(guildId: string, channelId: string): Promise<string | null> {
  if (!DISCORD_BOT_TOKEN) return null;

  try {
    const r = await fetch(`${API}/v10/guilds/${guildId}/channels`, {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
    });
    if (!r.ok) {
      console.warn(`[canal] Discord respondeu ${r.status} ao listar canais`);
      return null;
    }

    const channels = (await r.json()) as Array<{
      id: string;
      name?: string;
      parent_id?: string | null;
    }>;

    const channel = channels.find((c) => c.id === channelId);
    if (!channel?.name) return null;

    const category = channel.parent_id
      ? channels.find((c) => c.id === channel.parent_id)?.name
      : undefined;

    return category ? `${category} / ${channel.name}` : channel.name;
  } catch (err) {
    console.warn('[canal] falhou:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Como a pessoa se chama **naquele servidor**.
 *
 * O nome global do Discord raramente é o que a galera reconhece: quem está numa
 * comunidade costuma usar apelido de servidor, e mostrar o global faz a pessoa
 * aparecer com um nome que ninguém ali associa a ela.
 *
 * Ordem: apelido do servidor → nome de exibição global → usuário.
 *
 * @returns null quando não dá para saber — aí vale o nome que já veio do OAuth.
 */
export async function memberName(guildId: string, userId: string): Promise<string | null> {
  if (!DISCORD_BOT_TOKEN) return null;

  try {
    const r = await fetch(`${API}/v10/guilds/${guildId}/members/${userId}`, {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
    });
    if (!r.ok) return null;

    const m = (await r.json()) as {
      nick?: string | null;
      user?: { global_name?: string | null; username?: string };
    };
    return m.nick || m.user?.global_name || m.user?.username || null;
  } catch (err) {
    console.warn('[membro] falhou:', err instanceof Error ? err.message : err);
    return null;
  }
}

export type Presence = 'in' | 'out' | 'unknown';

/**
 * Os três estados de "em que call esta pessoa está".
 *
 * Um tipo à parte, e não `string | null`, porque `indeterminado` não é o mesmo
 * que `fora`: um é falta de visibilidade nossa — o bot não está no servidor —,
 * e o outro é a pessoa realmente fora da call. Tratá-los igual tranca gente
 * para fora por um problema que é nosso.
 */
export type VoiceLocation =
  | { type: 'in'; channel: string }
  | { type: 'out' }
  | { type: 'unknown' };

/**
 * Em qual canal de voz daquele servidor esta pessoa está.
 *
 * É o que sustenta a entrada por `/<id do servidor>`: quem abre esse endereço
 * não veio pela Activity, então não há `channel_id` vindo do cliente — quem
 * responde qual é o canal é o Discord, com o token do bot.
 */
export async function voiceChannelOf(guildId: string, userId: string): Promise<VoiceLocation> {
  if (!DISCORD_BOT_TOKEN) return { type: 'unknown' };

  try {
    const r = await fetch(`${API}/v10/guilds/${guildId}/voice-states/${userId}`, {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
    });

    if (r.status === 404) {
      // Mesma distinção de inVoiceChannel: "Unknown Guild" é falta de
      // visibilidade nossa, não ausência da pessoa.
      const err = (await r.json().catch(() => null)) as { code?: number } | null;
      return err?.code === 10004 ? { type: 'unknown' } : { type: 'out' };
    }

    if (!r.ok) {
      console.warn(`[voz] Discord respondeu ${r.status} ao buscar o canal`);
      return { type: 'unknown' };
    }

    const state = (await r.json()) as { channel_id?: string | null };
    return state.channel_id ? { type: 'in', channel: state.channel_id } : { type: 'out' };
  } catch (err) {
    console.warn('[voz] falhou:', err instanceof Error ? err.message : err);
    return { type: 'unknown' };
  }
}

/**
 * Confirma pelo Discord que a pessoa está mesmo naquela call.
 *
 * Sem isto o escopo por canal é obscuridade, não segurança: o `instance_id`
 * vem do cliente, e um cliente adulterado pode alegar qualquer canal. Aqui
 * quem responde é o Discord, com o token do bot.
 */
export async function inVoiceChannel(
  guildId: string | undefined,
  channelId: string | undefined,
  userId: string
): Promise<Presence> {
  if (!DISCORD_BOT_TOKEN || !guildId || !channelId) return 'unknown';

  try {
    const r = await fetch(`${API}/v10/guilds/${guildId}/voice-states/${userId}`, {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
    });

    if (r.status === 404) {
      // Dois 404 bem diferentes chegam aqui, e tratá-los igual trancava a
      // atividade para fora.
      //
      // "Unknown Guild" (10004) quer dizer que o BOT não está neste servidor —
      // o caso de quem instalou a atividade na própria conta, sem adicionar bot
      // nenhum. Isso não diz nada sobre a pessoa estar em call: é falta de
      // visibilidade nossa, não ausência dela. Antes virava "fora", o que
      // devolvia 403 e a atividade abria em "Não foi possível entrar".
      //
      // Qualquer outro 404 é o que o nome sugere: não há estado de voz para
      // essa pessoa neste servidor, então ela está fora da call.
      const err = (await r.json().catch(() => null)) as { code?: number } | null;
      if (err?.code === 10004) {
        console.warn('[voz] o bot nao esta neste servidor — escopo cai para a instancia');
        return 'unknown';
      }
      return 'out';
    }

    if (!r.ok) {
      console.warn(`[voz] Discord respondeu ${r.status} — verificação ignorada`);
      return 'unknown';
    }

    const state = (await r.json()) as { channel_id?: string };
    return state?.channel_id === channelId ? 'in' : 'out';
  } catch (err) {
    // Falha de rede não pode trancar todo mundo para fora.
    console.warn('[voz] falhou:', err instanceof Error ? err.message : err);
    return 'unknown';
  }
}
