import { post } from './api';
import { decode } from './badge';
import { read, remove, store } from './storage';
import type { RoomSummary, RoomTokens } from './types';

/**
 * As chamadas de sala, e onde os tokens dela ficam guardados.
 *
 * Nenhuma delas conhece React: o prefixo `/.proxy` chega como função (`api`),
 * porque quem sabe se estamos dentro da Activity é o contexto, e a mesma
 * chamada precisa servir ao lobby, à sala e ao arranque.
 */

type Renovar = () => Promise<string | null>;

/** A lista **não exige login** (RF-SAL-3): dá para ver o lobby antes de entrar. */
export function listRooms(
  api: (path: string) => string,
  identity: string | null
): Promise<{ rooms: RoomSummary[] }> {
  return post(api('/api/rooms/list'), identity ? { identity } : {});
}

export function createRoom(
  api: (path: string) => string,
  body: { identity: string; name?: string; password?: string },
  renew: Renovar
): Promise<RoomTokens> {
  return post(api('/api/rooms/create'), body, { renew });
}

export function joinRoom(
  api: (path: string) => string,
  body: { identity: string; roomId: string; password?: string },
  renew: Renovar
): Promise<RoomTokens> {
  return post(api('/api/rooms/join'), body, { renew });
}

/**
 * A sala do servidor, alcançada por `/<id do servidor>` (RF-SAL-11).
 *
 * Quem diz em qual call a pessoa está é o Discord, não o cliente — por isso
 * exige identidade do Discord, e convidado recebe 401.
 */
export function guildRoom(
  api: (path: string) => string,
  identity: string,
  guildId: string,
  /** Qual call, quando o link já diz. Sem isto, vale a call em que a pessoa está. */
  room: string | null,
  renew: Renovar
): Promise<RoomTokens> {
  return post(
    api('/api/rooms/guild'),
    room ? { identity, guild_id: guildId, room } : { identity, guild_id: guildId },
    { renew }
  );
}

/** A sala de um link fixo, `/s/<nome>`. Convidado também entra. */
export function fixedRoom(
  api: (path: string) => string,
  identity: string,
  slug: string,
  renew: Renovar
): Promise<RoomTokens> {
  return post(api('/api/rooms/fixed'), { identity, slug }, { renew });
}

/** A sala fixa daquela call, criada na primeira pessoa que chega (RF-SAL-1). */
export function callRoom(
  api: (path: string) => string,
  identity: string,
  renew: Renovar
): Promise<RoomTokens> {
  return post(api('/api/rooms/call'), { identity }, { renew });
}

/** Só o dono muda a senha; campo vazio a remove (RF-SAL-6, RN-SAL-15). */
export function setPassword(
  api: (path: string) => string,
  body: { identity: string; roomId: string; password: string },
  renew: Renovar
): Promise<{ ok: boolean; locked: boolean }> {
  return post(api('/api/rooms/password'), body, { renew });
}

// ------------------------------------------------------------------ guardados

/**
 * Os tokens de uma sala em que já entramos (RF-SAL-9).
 *
 * Numa visita seguinte, entra sem pedir a senha de novo. Se o token guardado
 * falhar, o fluxo normal assume e pede a senha — por isso ele é uma tentativa,
 * não uma garantia. Tokens de sala não expiram (RN-SAL-21): a sala fecha ao
 * esvaziar e o id é aleatório, então o token morre junto com ela.
 */
/**
 * A chave no armazenamento é `sala:<id>` (RF-SAL-9) e continua em português de
 * propósito: é o que já está gravado no navegador de quem usa, e renomear
 * orfanaria a sessão — a pessoa voltaria a digitar a senha de toda sala. O porte
 * chegou a gravar `room:<id>`; a leitura ainda aceita essa, e a próxima gravação
 * migra.
 */
const KEY = (roomId: string) => `sala:${roomId}`;
const LEGACY_KEY = (roomId: string) => `room:${roomId}`;

export function storedTokens(roomId: string, uid: string): RoomTokens | null {
  const cru = read(KEY(roomId)) ?? read(LEGACY_KEY(roomId));
  if (!cru) return null;

  let tokens: RoomTokens;
  try {
    tokens = JSON.parse(cru) as RoomTokens;
  } catch {
    return null;
  }

  // O token carrega o `uid` de quem o pediu, e a chave é a sala — não a pessoa.
  // Reaproveitá-lo depois de a identidade mudar coloca você na sala com o nome
  // antigo, enquanto o dock mostra o novo: duas identidades na mesma aba, sem
  // nada acusando. Só o dono do token pode reusá-lo.
  if (decode(tokens.viewerToken)?.uid !== uid) {
    forgetTokens(roomId);
    return null;
  }

  return tokens;
}

export function saveTokens(tokens: RoomTokens): void {
  store(KEY(tokens.roomId), JSON.stringify(tokens));
  remove(LEGACY_KEY(tokens.roomId));
}

export function forgetTokens(roomId: string): void {
  remove(KEY(roomId));
  remove(LEGACY_KEY(roomId));
}

/**
 * A sala atual na barra de endereço (RF-SAL-8), em `?room=`.
 *
 * O parâmetro é o que a pessoa cola num convite. Ele **não dá acesso**: no
 * contexto de servidor quem autoriza é estar na call (RN-SAL-4), e no lobby o
 * token guardado ou a senha continuam mandando.
 *
 * Preserva os parâmetros do Discord de propósito: perder `frame_id` no meio de
 * uma troca de sala faria a atividade achar que saiu da Activity, e o prefixo
 * `/.proxy` sumiria de todas as chamadas seguintes.
 */
export function writeRoomInUrl(roomId: string | null): void {
  const url = new URL(location.href);
  if (roomId) url.searchParams.set('room', roomId);
  else url.searchParams.delete('room');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
