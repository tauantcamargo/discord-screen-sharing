import { DiscordSDK } from '@discord/embedded-app-sdk';

import { post } from './api';
import { decode, discard, save, stored } from './badge';
import { read } from './storage';
import type { Session } from './types';

/**
 * Como a pessoa passa a ter identidade, nos dois contextos.
 *
 * Dentro do Discord o login é automático e sem tela (RF-SES-1). Fora dele a
 * pessoa entra como convidado (RF-SES-3), e o login do Discord é uma melhoria
 * opcional — não um pedágio para assistir uma tela.
 */

/**
 * O SDK, guardado depois do login.
 *
 * Abrir a aba de captura de dentro da Activity precisa passar por ele
 * (RN-TRX-8): `window.open` dentro do iframe do Discord não chega a lugar
 * nenhum. Uma instância só, criada no login e reusada.
 */
let activeSdk: DiscordSDK | null = null;

export const sdk = () => activeSdk;

/** Onde o apelido escolhido pela pessoa vive (RN-SES-13). */
export const STORED_NAME = 'displayName';

/** O apelido guardado, que é reenviado a cada conexão do WebSocket. */
export const storedName = () => read(STORED_NAME);

/**
 * O crachá devolvido pelo callback do OAuth, se estivermos voltando dele.
 *
 * Ele chega no **fragmento** da URL (`/#identity=…`), nunca na query: o
 * fragmento não é enviado ao servidor nem aparece em log de proxy (RN-SES-9).
 * Lido uma vez, some da barra de endereço por `history.replaceState` — o token
 * não fica visível nem no histórico.
 */
export function takeIdentityFromHash(): string | null {
  if (typeof location === 'undefined' || !location.hash) return null;

  const hash = new URLSearchParams(location.hash.slice(1));
  const identity = hash.get('identity');
  if (!identity) return null;

  hash.delete('identity');
  const rest = hash.toString();
  history.replaceState(null, '', `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`);

  // Só aceita o crachá se este navegador acabou de passar pelo callback do
  // login (o servidor deixa a marca `sdt_login_ok` por 2 minutos). Um link
  // `/#identity=…` montado por outra pessoa não traz a marca, e é ignorado —
  // senão bastava mandar o link para a vítima operar com a conta de quem o fez.
  const fromLogin = document.cookie.split(';').some((c) => c.trim() === 'sdt_login_ok=1');
  if (!fromLogin) return null;
  document.cookie = 'sdt_login_ok=; Path=/; Max-Age=0; SameSite=Lax';

  save(identity);
  return identity;
}

/**
 * A sessão que já existe, reconstruída do crachá guardado.
 *
 * Sem isto, cada carga da página emitia uma identidade nova — e o efeito
 * colateral aparecia longe da causa: os tokens de sala guardados (RF-SAL-9)
 * pertencem à identidade que os pediu, então entrar de novo colocava a pessoa
 * na sala com o nome antigo, enquanto o dock mostrava o novo. Duas identidades
 * na mesma aba, sem nada acusando.
 *
 * O crachá já foi validado uma vez pelo servidor e traz tudo que a interface
 * precisa. Quem confere a assinatura continua sendo o servidor, na primeira
 * chamada que o levar (RN-SES-12).
 */
export function restoreSession(): Session | null {
  const identity = stored();
  if (!identity) return null;

  const claims = decode(identity);
  if (!claims?.uid) return null;

  return {
    user: { id: claims.uid, name: storedName() ?? claims.name, avatar: claims.av },
    instance: claims.instance,
    identity,
    ...(claims.call ? { call: claims.call } : {}),
  };
}

/** Convidado: identidade sem login nenhum (RF-SES-3). */
export function authGuest(api: (path: string) => string): Promise<Session> {
  const name = storedName();
  return post<Session>(api('/api/session-guest'), name ? { name } : {});
}

/**
 * Login pelo Discord, dentro da Activity (RF-SES-1).
 *
 * O `clientId` vem preferencialmente do `client_id` que o Discord injeta na URL
 * do iframe (RN-SES-6); a configuração do servidor entra só como reserva.
 * Depender da ida ao servidor deixava a atividade parada sem nada para mostrar
 * quando ela demorava.
 */
export async function authDiscord(
  clientId: string,
  api: (path: string) => string
): Promise<Session> {
  const instance = new DiscordSDK(clientId);
  activeSdk = instance;
  await instance.ready();

  const { code } = await instance.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    // Só precisamos de /users/@me. Menos escopo, menos atrito no consentimento
    // (RN-SES-5).
    scope: ['identify'],
  });

  const { access_token } = await post<{ access_token: string }>(api('/api/token'), {
    code,
    client_id: clientId,
  });
  await instance.commands.authenticate({ access_token });

  // servidor/channel vão junto para o servidor poder confirmar, pelo Discord, que
  // a pessoa está mesmo naquela call (RF-SES-2).
  return post<Session>(api('/api/session'), {
    access_token,
    instance_id: instance.instanceId,
    guild_id: instance.guildId,
    channel_id: instance.channelId,
  });
}

/**
 * O client id que vale, na ordem que importa (RN-SES-6).
 *
 * A URL do iframe primeiro; o HTML renderizado pelo servidor depois
 * (RN-SES-4). Nenhum dos dois custa uma ida à rede.
 */
export function clientIdOf(params: URLSearchParams): string | null {
  return params.get('client_id') || window.__ROOM__?.clientId || null;
}

/**
 * Emite uma identidade nova, jogando fora a que o servidor recusou (RF-SES-5).
 *
 * É o `renew` que o `post` chama diante de um 401. Devolve null quando nem a
 * emissão nova funciona — aí o erro é outro, e insistir não ajuda.
 */
export function renewer(
  inDiscord: boolean,
  clientId: string | null,
  api: (path: string) => string,
  onRenew: (session: Session) => void
): () => Promise<string | null> {
  return async () => {
    discard();
    try {
      // Dentro da Activity só o Discord emite identidade válida: cair para
      // convidado aqui daria um crachá de instância `web`, que não abre a sala
      // da call. Sem client id, renovar não é possível — e insistir viraria
      // laço (RF-SES-5).
      if (inDiscord && !clientId) return null;

      const session = inDiscord
        ? await authDiscord(clientId as string, api)
        : await authGuest(api);
      save(session.identity);
      onRenew(session);
      return session.identity;
    } catch {
      return null;
    }
  };
}

export { stored as storedBadge, save as saveBadge, discard as discardBadge };
