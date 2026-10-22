/**
 * Registro e relay de salas.
 *
 * Salas são criadas explicitamente por alguém e vivem em memória. Cada uma
 * pertence a uma instância da Activity (o canal de voz), então canais
 * diferentes não enxergam as salas uns dos outros.
 *
 * Vários transmissores simultâneos por sala; N espectadores. Cada transmissor
 * recebe um "slot" numérico e carimba esse número no primeiro byte de todo
 * quadro, então o servidor repassa o buffer sem tocar nele e o espectador sabe
 * para qual decodificador mandar.
 *
 * O servidor não decodifica nada. Ele guarda o config de cada transmissor e
 * distingue keyframe de delta, porque quem começa a assistir precisa de um
 * keyframe: delta em decodificador frio só dá erro.
 *
 * As mensagens JSON e o cabeçalho binário são contrato herdado — `.claude/.claude/specs/09-protocolo.md`. Nada aqui pode mudar de nome sem quebrar o cliente antigo.
 */
import crypto from "node:crypto";
import { promisify } from "node:util";

import { LIMITS_OFF } from "./limits.ts";

import type { WebSocket } from "ws";
import type {
  Broadcast,
  CodecConfig,
  PasswordHash,
  Person,
  Room,
  Viewer,
} from "./types.ts";

// 256, e não um teto de produto: o slot vai carimbado num único byte no
// cabeçalho binário (`[1B slot]...`, `.claude/specs/09-protocolo.md`), e esse
// é o único limite real de quantas transmissões cabem numa sala.
const MAX_BROADCASTERS = 256;

/**
 * A chave real de `room.broadcasters` (RF-CAM-3): uma pessoa pode ter **até
 * duas** transmissões ao mesmo tempo na mesma sala — uma de tela, uma de
 * câmera —, cada uma com o próprio slot. Por `uid` sozinho bastava quando só
 * existia uma transmissão por pessoa; agora o par uid+kind é que identifica
 * uma transmissão.
 */
const broadcastKey = (uid: string, kind: "screen" | "camera"): string =>
  `${uid}:${kind}`;

const isBroadcasting = (room: Room, uid: string): boolean =>
  room.broadcasters.has(broadcastKey(uid, "screen")) ||
  room.broadcasters.has(broadcastKey(uid, "camera"));

/**
 * Teto de espectadores **por transmissão** (RF-AST-11).
 *
 * A banda de subida cresce linearmente com quem assiste (RN-TRX-34): a 8 Mbps o
 * décimo espectador já pede 80 Mb/s de upload, que ninguém tem. Sem teto o
 * sintoma não é uma recusa clara — é a transmissão de todo mundo degradando
 * junto, com o backpressure descartando quadros sem ninguém entender por quê.
 *
 * É por transmissão, e não por sala (RN-AST-28): quatro telas com doze
 * espectadores cada é banda de quatro transmissores diferentes.
 */
const MAX_VIEWERS_PER_STREAM = Number(process.env.MAX_VIEWERS_PER_STREAM) || 12;
// Sala é objeto em memória criado por qualquer pessoa autenticada: sem teto,
// um laço de "criar sala" consome a RAM do processo.
const MAX_ROOMS_PER_INSTANCE = 20;
// O teto por instância sozinho não segura: a instância vem do cliente, e
// convidados são de graça. Por dono e no total, também.
const MAX_ROOMS_PER_OWNER = 3;
const MAX_ROOMS_TOTAL = 500;
// Senha é hash scrypt: tamanho sem teto é CPU sem teto.
const MAX_PASSWORD = 128;
// Mensagens de controle (JSON) não são descartáveis como quadros de vídeo,
// mas um cliente que não lê nada acumula fila sem fim na memória do servidor.
// Passou disto, a conexão cai — o cliente reconecta e recebe o estado inteiro.
const MAX_CONTROL_BUFFER = 8 * 1024 * 1024;
// Anúncios de estado em rajada viram um só: um laço de rename/watch/unwatch
// fazia o servidor reenviar a sala inteira para todo mundo a cada mensagem.
const STATE_COALESCE_MS = 100;
// 2 MB (4 para keyframe) era o valor herdado — e a um bitrate de 1 Mbps
// (preset Leve) isso é **16 segundos** de vídeo enfileirado antes de o
// servidor sequer começar a descartar. Enquanto essa fila escoa, tudo que sai
// depois dela também espera — inclusive o `stream-stop` de quem parou de
// transmitir, que chega minutos depois de a transmissão já ter acabado
// (RF-AST-18a). A um bitrate alto (8 Mbps) o mesmo teto vira só 2 s, então o
// valor bom para um preset é ruim demais para outro. 400 KB fica perto de 1 s
// no preset mais pesado e de 3,2 s no mais leve — ainda folgado para uma
// rajada, mas curto o bastante para o descarte (e o resync de RN-AST-3a)
// entrarem enquanto a pessoa ainda está olhando para a tela travada.
const MAX_BUFFERED_BYTES = 400 * 1024;

/**
 * Espaçamento do aviso de descarte ao espectador (RF-AST-18).
 *
 * Sem isto, quem está com rede ruim recebe um aviso por quadro perdido — dezenas
 * por segundo, no mesmo socket que já não dá conta. Um a cada 2 s basta para o
 * indicador de qualidade saber que o problema é do lado de quem assiste, e não
 * de quem transmite — que é justamente a pergunta que se faz nessa hora.
 */
const DROP_NOTICE_MS = 2000;
const MAX_NAME = 32;
const MAX_ROOM_NAME = 40;

// Sala vazia fecha, mas não no mesmo instante: recarregar a atividade
// desconecta e reconecta, e quem estivesse sozinho perderia a sala a cada F5.
// 12s cobre um reload com folga e some rápido o bastante para não deixar sala
// fantasma na lista.
const EMPTY_GRACE_MS = 12_000;
const SWEEP_EVERY_MS = 4_000;

// Freio de força bruta: sem isso uma senha curta cai em segundos, porque o
// endpoint responde tão rápido quanto a rede permite.
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 60_000;
const LOCKOUT_MS = 30_000;

const SLOT_BYTE = 0;
const TYPE_BYTE = 1;
const TYPE_KEYFRAME = 1;
const TYPE_AUDIO = 3;

const rooms = new Map<string, Room>();

// --------------------------------------------------------------------- senha

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Assíncrono de propósito: o scryptSync parava o event loop por dezenas de ms a
 * cada tentativa — e o mesmo loop é o que repassa o vídeo de todas as salas.
 */
async function hashPassword(
  password: string,
  salt: Buffer = crypto.randomBytes(16),
): Promise<PasswordHash> {
  return { salt, hash: await scrypt(password.slice(0, MAX_PASSWORD), salt, 32) };
}

async function passwordMatches(room: Room, password: string): Promise<boolean> {
  if (!room.password) return true;
  const stored = room.password;
  const { hash } = await hashPassword(password, stored.salt);
  return crypto.timingSafeEqual(hash, stored.hash);
}

/**
 * Tentativas por pessoa, e não pela sala inteira: antes, 5 erros de qualquer
 * um trancavam todo mundo por 30 s — um jeito barato de impedir a entrada dos
 * outros.
 */
interface AttemptState {
  attempts: number[];
  lockedUntil: number;
}
const attemptsByKey = new Map<string, AttemptState>();

function attemptState(room: Room, who: string): AttemptState {
  const key = `${room.id}:${who}`;
  let st = attemptsByKey.get(key);
  if (!st) {
    st = { attempts: [], lockedUntil: 0 };
    attemptsByKey.set(key, st);
  }
  return st;
}

/** null se pode tentar, ou os segundos que faltam para liberar. */
function lockoutRemaining(st: AttemptState): number | null {
  if (!st.lockedUntil) return null;
  const left = st.lockedUntil - Date.now();
  if (left <= 0) {
    st.lockedUntil = 0;
    st.attempts = [];
    return null;
  }
  return Math.ceil(left / 1000);
}

export type PasswordVerdict =
  | { ok: true }
  | { ok: false; reason: "password" }
  | { ok: false; reason: "locked"; seconds: number };

export async function checkPassword(
  room: Room,
  who: string,
  password: string | undefined,
): Promise<PasswordVerdict> {
  const st = attemptState(room, who);
  const locked = lockoutRemaining(st);
  if (locked !== null) return { ok: false, reason: "locked", seconds: locked };

  if (await passwordMatches(room, password ?? "")) {
    st.attempts = [];
    return { ok: true };
  }

  const now = Date.now();
  st.attempts = st.attempts.filter((t) => now - t < ATTEMPT_WINDOW_MS);
  st.attempts.push(now);

  if (st.attempts.length >= MAX_ATTEMPTS) {
    st.lockedUntil = now + LOCKOUT_MS;
    return {
      ok: false,
      reason: "locked",
      seconds: Math.ceil(LOCKOUT_MS / 1000),
    };
  }
  return { ok: false, reason: "password" };
}

/** Só o dono mexe na senha. Passar vazio remove. @returns erro, ou null. */
export async function setPassword(
  room: Room,
  uid: string,
  password: string | null,
): Promise<string | null> {
  if (room.ownerId !== uid) return "Só quem criou a sala pode mudar a senha.";
  if (password && password.length > MAX_PASSWORD) {
    return `A senha pode ter no máximo ${MAX_PASSWORD} caracteres.`;
  }

  room.password = password ? await hashPassword(String(password)) : null;
  for (const key of attemptsByKey.keys()) {
    if (key.startsWith(`${room.id}:`)) attemptsByKey.delete(key);
  }
  broadcastState(room);
  return null;
}

// ------------------------------------------------------------------ registro

function blankRoom(id: string, instance: string, name: string): Room {
  return {
    id,
    instance,
    name,
    isCall: false,
    ownerId: null,
    ownerName: "",
    password: null,
    attempts: [],
    lockedUntil: 0,
    createdAt: Date.now(),
    emptySince: Date.now(),
    broadcasters: new Map(),
    slots: new Map(),
    viewers: new Map(),
    droppedChunks: 0,
  };
}

export async function createRoom(input: {
  instance: string;
  name?: string | undefined;
  ownerId: string;
  ownerName: string;
  password?: string | null;
}): Promise<{ room: Room } | { error: string }> {
  const all = [...rooms.values()];
  const open = all.filter((r) => r.instance === input.instance).length;
  if (open >= MAX_ROOMS_PER_INSTANCE || all.length >= MAX_ROOMS_TOTAL) {
    return {
      error:
        "Limite de salas abertas atingido. Feche uma antes de criar outra.",
    };
  }
  if (
    !LIMITS_OFF &&
    all.filter((r) => r.ownerId === input.ownerId).length >= MAX_ROOMS_PER_OWNER
  ) {
    return {
      error: `Você já tem ${MAX_ROOMS_PER_OWNER} salas abertas. Feche uma antes de criar outra.`,
    };
  }
  if (input.password && input.password.length > MAX_PASSWORD) {
    return { error: `A senha pode ter no máximo ${MAX_PASSWORD} caracteres.` };
  }

  const chosen = String(input.name ?? "")
    .replace(/\s+/g, " ")
    .trim();
  // Nome é opcional: sem ele, um baseado em quem criou.
  const name = (chosen || `Sala de ${input.ownerName}`).slice(0, MAX_ROOM_NAME);

  const room = blankRoom(
    crypto.randomBytes(6).toString("base64url"),
    input.instance,
    name,
  );
  room.ownerId = input.ownerId;
  room.ownerName = input.ownerName;
  room.password = input.password ? await hashPassword(String(input.password)) : null;

  rooms.set(room.id, room);
  return { room };
}

export const getRoom = (id: unknown): Room | null =>
  typeof id === "string" ? (rooms.get(id) ?? null) : null;

/**
 * A sala fixa de uma call: id derivado do canal, criada na primeira entrada.
 *
 * Não tem dono nem senha — quem controla o acesso é a própria call, já que só
 * entra quem o Discord confirmou estar conectado ao canal.
 */
export function ensureCallRoom(
  instance: string,
  id: string,
  name?: string | null,
): Room {
  const existing = rooms.get(id);
  if (existing) {
    // A instância da Activity muda a cada relançamento no mesmo canal; o canal
    // é que é estável. Sem atualizar, a sala sumiria da lista após um relaunch.
    existing.instance = instance;
    // O canal pode ter sido renomeado no Discord desde que a sala nasceu.
    if (name) existing.name = name;
    return existing;
  }

  const room = blankRoom(id, instance, name || "Sala da call");
  room.isCall = true;
  room.ownerName = "a call";

  rooms.set(id, room);
  return room;
}

/**
 * Lista pública: nunca vaza hash de senha, só se ela existe.
 *
 * A sala automática da call fica de fora: dentro do Discord a atividade entra
 * nela direto, e no site ela nunca poderia ser aberta. Listá-la seria mostrar
 * uma porta que não abre.
 */
export function listRooms(instance: string) {
  return [...rooms.values()]
    .filter((r) => r.instance === instance && !r.isCall)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((r) => ({
      id: r.id,
      name: r.name,
      owner: r.ownerName,
      isCall: r.isCall,
      locked: Boolean(r.password),
      people: countPeople(r),
      streams: [...r.broadcasters.values()].filter((b) => b.streaming).length,
    }));
}

function countPeople(room: Room): number {
  const ids = new Set<string>();
  for (const v of room.viewers.values()) ids.add(v.info.id);
  for (const b of room.broadcasters.values()) ids.add(b.info.id);
  return ids.size;
}

/**
 * Fecha salas vazias há tempo demais.
 *
 * `unref` para o varredor não segurar o processo de pé sozinho: sem ele um
 * Ctrl+C fica esperando o próximo tique.
 */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const empty = room.viewers.size === 0 && room.broadcasters.size === 0;

    if (!empty) {
      room.emptySince = null;
      continue;
    }
    if (room.emptySince === null) {
      room.emptySince = now;
      continue;
    }
    if (now - room.emptySince > EMPTY_GRACE_MS) {
      forget(room);
      console.log(`[room ${room.id}] fechada por inatividade`);
    }
  }
}, SWEEP_EVERY_MS);
sweeper.unref();

// ---------------------------------------------------------------------- envio

function send(ws: WebSocket, data: string | Buffer): boolean {
  if (ws.readyState !== ws.OPEN) return false;
  if (ws.bufferedAmount > MAX_CONTROL_BUFFER) {
    ws.terminate();
    return false;
  }
  ws.send(data);
  return true;
}

/** Remove a sala e tudo que é indexado por ela. */
function forget(room: Room): void {
  rooms.delete(room.id);
  const pending = pendingState.get(room);
  if (pending) clearTimeout(pending);
  pendingState.delete(room);
  for (const key of attemptsByKey.keys()) {
    if (key.startsWith(`${room.id}:`)) attemptsByKey.delete(key);
  }
}

export const sendJson = (ws: WebSocket, obj: unknown): boolean =>
  send(ws, JSON.stringify(obj));

function toViewers(room: Room, obj: unknown): void {
  const msg = JSON.stringify(obj);
  for (const v of room.viewers.values()) send(v.ws, msg);
}

// --------------------------------------------------------------------- estado

// O avatar vai junto do nome: a lista de quem assiste mostra as fotos, e sem
// isto sobrava só a inicial colorida para quem tem foto no Discord.
/**
 * Avisa o espectador de que estamos descartando quadros dele (RF-AST-18).
 *
 * Antes disto o descarte só incrementava um contador no log, e o indicador de
 * qualidade não distinguia rede de quem assiste de rede de quem transmite.
 */
function warnDropped(viewer: Viewer, slot: number): void {
  const now = Date.now();
  if (now - (viewer.notifiedAt ?? 0) < DROP_NOTICE_MS) return;
  viewer.notifiedAt = now;
  sendJson(viewer.ws, { type: "dropped", slot });
}

function watchersOf(room: Room, slot: number): Person[] {
  const byId = new Map<string, Person>();
  for (const v of room.viewers.values()) {
    if (v.watching.has(slot)) byId.set(v.info.id, v.info);
  }
  return [...byId.values()];
}

function roomState(room: Room) {
  // Uma pessoa pode ter a sala aberta em mais de uma aba; agrupamos por id
  // para não aparecer duplicada na lista.
  const byId = new Map<string, Person>();
  for (const v of room.viewers.values()) byId.set(v.info.id, v.info);

  const participants = [...byId.values()].map((info) => ({
    ...info,
    broadcasting: isBroadcasting(room, info.id),
  }));

  // Quem transmite pode ter fechado a aba da Activity: continua na lista,
  // senão o vídeo fica sem dono visível.
  for (const b of room.broadcasters.values()) {
    if (byId.has(b.info.id)) continue;
    byId.set(b.info.id, b.info);
    participants.push({ ...b.info, broadcasting: true });
  }

  participants.sort((a, b) => Number(b.broadcasting) - Number(a.broadcasting));

  return {
    type: "state",
    room: {
      id: room.id,
      name: room.name,
      ownerId: room.ownerId,
      locked: Boolean(room.password),
    },
    broadcasting: room.broadcasters.size > 0,
    viewers: room.viewers.size,
    participants,
    streams: [...room.broadcasters.values()]
      .filter((b) => b.streaming)
      .map((b) => ({
        slot: b.slot,
        userId: b.info.id,
        kind: b.kind,
        watchers: watchersOf(room, b.slot),
      })),
  };
}

const pendingState = new Map<Room, ReturnType<typeof setTimeout>>();

/**
 * Anuncia o estado da sala — coalescido: várias mudanças em 100 ms viram um
 * anúncio só, calculado no fim com o estado mais novo.
 */
export function broadcastState(room: Room): void {
  if (pendingState.has(room)) return;
  pendingState.set(
    room,
    setTimeout(() => {
      pendingState.delete(room);
      if (rooms.get(room.id) !== room) return;
      const msg = JSON.stringify(roomState(room));
      for (const v of room.viewers.values()) send(v.ws, msg);
      for (const b of room.broadcasters.values()) send(b.ws, msg);
    }, STATE_COALESCE_MS),
  );
}

export function rename(room: Room, ws: WebSocket, raw: unknown): void {
  const viewer = room.viewers.get(ws);
  if (!viewer || typeof raw !== "string") return;

  const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  if (!name) return;

  viewer.info = { ...viewer.info, name };
  // A chave é `uid:kind` desde RF-CAM-1; procurar só por `uid` não achava
  // ninguém, e o nome do transmissor ficava o antigo.
  for (const kind of ["screen", "camera"] as const) {
    const broadcast = room.broadcasters.get(broadcastKey(viewer.info.id, kind));
    if (broadcast) broadcast.info = { ...broadcast.info, name };
  }
  broadcastState(room);
}

// ---------------------------------------------------------------- transmissor

function freeSlot(room: Room): number | null {
  for (let i = 0; i < MAX_BROADCASTERS; i++) {
    if (!room.slots.has(i)) return i;
  }
  return null;
}

/**
 * A transmissão criada, ou uma string com o motivo da recusa.
 *
 * `kind` já vem resolvido na conexão (RF-CAM-3) — a URL do WebSocket carrega
 * `?kind=`, porque o `start` chega tarde demais para decidir se esta conexão
 * pode existir: o slot e a checagem de duplicata têm que acontecer aqui.
 */
export function attachBroadcaster(
  room: Room,
  ws: WebSocket,
  info: Person,
  kind: "screen" | "camera",
): Broadcast | string {
  if (room.broadcasters.has(broadcastKey(info.id, kind))) {
    return kind === "camera"
      ? "Sua câmera já está ligada nesta sala."
      : "Você já está compartilhando a tela nesta sala.";
  }
  if (room.broadcasters.size >= MAX_BROADCASTERS) {
    return `Limite de ${MAX_BROADCASTERS} transmissões simultâneas atingido.`;
  }

  const slot = freeSlot(room);
  if (slot === null) return "Sem espaço para mais transmissões.";

  const broadcast: Broadcast = {
    ws,
    info,
    slot,
    streaming: false,
    config: null,
    audioConfig: null,
    kind,
  };
  room.broadcasters.set(broadcastKey(info.id, kind), broadcast);
  room.slots.set(slot, broadcast);
  room.emptySince = null;

  sendJson(ws, { type: "slot", slot });
  broadcastState(room);
  return broadcast;
}

export function startStream(room: Room, b: Broadcast): void {
  b.streaming = true;
  b.config = null;
  b.audioConfig = null;
  // Transmissão nova recomeça do zero: ninguém assiste até pedir.
  for (const v of room.viewers.values()) {
    v.primed.delete(b.slot);
    v.watching.delete(b.slot);
  }
  toViewers(room, {
    type: "stream-start",
    slot: b.slot,
    userId: b.info.id,
    kind: b.kind,
  });
  broadcastState(room);
}

/**
 * Config do áudio, guardada e repassada igual à do vídeo.
 *
 * Quem começa a assistir no meio precisa dela para montar o decodificador — e,
 * ao contrário do vídeo, aqui não existe keyframe para servir de ponto de
 * partida: sem a config, nenhum pacote de som é aproveitável.
 */
export function setAudioConfig(
  room: Room,
  b: Broadcast,
  config: CodecConfig,
): void {
  b.audioConfig = config;
  for (const v of room.viewers.values()) {
    if (v.watching.has(b.slot)) {
      sendJson(v.ws, { type: "audio-config", slot: b.slot, config });
    }
  }
}

export function setConfig(room: Room, b: Broadcast, config: CodecConfig): void {
  b.config = config;
  // Config nova significa decodificador recriado; ele volta a precisar de
  // keyframe.
  for (const v of room.viewers.values()) {
    v.primed.delete(b.slot);
    if (v.watching.has(b.slot))
      sendJson(v.ws, { type: "config", slot: b.slot, config });
  }
}

export function relayChunk(room: Room, b: Broadcast, chunk: Buffer): void {
  // O transmissor carimba o próprio slot; conferimos para um cliente adulterado
  // não conseguir injetar quadros no stream de outra pessoa.
  if (chunk[SLOT_BYTE] !== b.slot) return;

  const type = chunk[TYPE_BYTE];
  const isKeyframe = type === TYPE_KEYFRAME;
  const isAudio = type === TYPE_AUDIO;

  for (const v of room.viewers.values()) {
    if (v.ws.readyState !== v.ws.OPEN) continue;

    // Assistir é opt-in: quem não pediu esta tela não recebe os bytes dela.
    if (!v.watching.has(b.slot)) continue;

    // Áudio não depende de keyframe — cada pacote Opus se decodifica sozinho —,
    // então não passa pelo controle de "já recebeu ponto de partida".
    if (isAudio) {
      if (v.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        room.droppedChunks++;
        warnDropped(v, b.slot);
        continue;
      }
      v.ws.send(chunk);
      continue;
    }

    if (isKeyframe) {
      // Teto dobrado: o keyframe é o que destrava a imagem, e descartá-lo
      // deixa a pessoa na tela preta até o próximo — que só vem quando alguém
      // pedir de novo.
      if (v.ws.bufferedAmount > MAX_BUFFERED_BYTES * 2) {
        room.droppedChunks++;
        warnDropped(v, b.slot);
        continue;
      }
      v.ws.send(chunk);
      v.primed.add(b.slot);
      continue;
    }

    if (!v.primed.has(b.slot)) continue;

    if (v.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      room.droppedChunks++;
      // Faltava aqui (RF-AST-18 só cobria keyframe e áudio): descarte de delta
      // é o caso mais comum — é ele que trava a imagem no meio de uma
      // transmissão —, e sem avisar o indicador de qualidade nunca via o
      // problema, e o cliente não tinha como saber que precisava pedir um
      // keyframe novo para se recuperar.
      warnDropped(v, b.slot);
      continue;
    }
    v.ws.send(chunk);
  }
}

export function stopStream(room: Room, b: Broadcast): void {
  if (!b.streaming) return;
  b.streaming = false;
  b.config = null;
  b.audioConfig = null;
  for (const v of room.viewers.values()) {
    v.primed.delete(b.slot);
    v.watching.delete(b.slot);
  }
  toViewers(room, { type: "stream-stop", slot: b.slot });
}

export function detachBroadcaster(room: Room, b: Broadcast): void {
  // Só remove se ainda for a transmissão registrada: uma reconexão rápida pode
  // ter posto outra no lugar, e apagá-la aqui derrubaria a que está no ar.
  const key = broadcastKey(b.info.id, b.kind);
  if (room.broadcasters.get(key) !== b) return;

  stopStream(room, b);
  room.broadcasters.delete(key);
  room.slots.delete(b.slot);
  broadcastState(room);
}

export const broadcasterOf = (
  room: Room,
  uid: string,
  kind: "screen" | "camera",
): Broadcast | null => room.broadcasters.get(broadcastKey(uid, kind)) ?? null;

// ----------------------------------------------------------------- espectador

export function watch(room: Room, ws: WebSocket, slot: number): void {
  const viewer = room.viewers.get(ws);
  const b = room.slots.get(slot);
  if (!viewer || !b || !b.streaming) return;
  // Repetir o pedido não muda nada, mas custaria um anúncio de estado para a
  // sala inteira — um cliente em laço faria o servidor inundar todo mundo.
  if (viewer.watching.has(slot)) return;

  if (watchersOf(room, slot).length >= MAX_VIEWERS_PER_STREAM) {
    sendJson(ws, {
      type: "error",
      message: "Esta tela já está no limite de espectadores.",
    });
    return;
  }

  viewer.watching.add(slot);
  viewer.primed.delete(slot);

  if (b.config) sendJson(ws, { type: "config", slot, config: b.config });
  if (b.audioConfig)
    sendJson(ws, { type: "audio-config", slot, config: b.audioConfig });

  // Em vez de guardar um keyframe antigo, pedimos um novo: a tela aparece em
  // ~1 quadro, e o servidor não precisa segurar buffer de ninguém.
  sendJson(b.ws, { type: "need-keyframe" });
  broadcastState(room);
}

/**
 * Pede um keyframe de novo para quem **já está assistindo** (RF-AST-18a).
 *
 * `watch()` só pede uma vez, na entrada — e não existia nada que pedisse de
 * novo se aquele pedido (ou o próprio keyframe) se perdesse no caminho. Sem
 * isso, quem caía nesse buraco ficava vendo "Conectando…" para sempre, e quem
 * já estava assistindo e sofria um descarte no meio da transmissão dependia só
 * do keyframe periódico do transmissor (a cada 3 s) para voltar a ver algo —
 * o cliente pede isto sempre que passa um tempo sem desenhar um quadro
 * enquanto descartes continuam chegando.
 *
 * Diferente de `watch()`: não mexe em `watching` nem reemite o estado da sala
 * — é só um "de novo, por favor" para quem já tinha pedido, então não custa
 * nada repetir sob demanda.
 */
export function rewatch(room: Room, ws: WebSocket, slot: number): void {
  const viewer = room.viewers.get(ws);
  const b = room.slots.get(slot);
  if (!viewer || !b || !b.streaming || !viewer.watching.has(slot)) return;

  if (b.config) sendJson(ws, { type: "config", slot, config: b.config });
  if (b.audioConfig)
    sendJson(ws, { type: "audio-config", slot, config: b.audioConfig });
  sendJson(b.ws, { type: "need-keyframe" });
}

export function unwatch(room: Room, ws: WebSocket, slot: number): void {
  const viewer = room.viewers.get(ws);
  // Só avisa a sala se algo mudou de fato; ver a nota em watch().
  if (!viewer?.watching.delete(slot)) return;
  viewer.primed.delete(slot);
  broadcastState(room);
}

export function attachViewer(room: Room, ws: WebSocket, info: Person): void {
  const viewer: Viewer = { ws, info, watching: new Set(), primed: new Set() };
  room.viewers.set(ws, viewer);
  room.emptySince = null;

  sendJson(ws, roomState(room));

  // Anuncia o que está no ar, sem começar a mandar quadros: assistir é opt-in.
  for (const b of room.broadcasters.values()) {
    if (!b.streaming) continue;
    sendJson(ws, {
      type: "stream-start",
      slot: b.slot,
      userId: b.info.id,
      kind: b.kind,
    });
  }

  broadcastState(room);
}

export function detachViewer(room: Room, ws: WebSocket): void {
  if (!room.viewers.delete(ws)) return;
  broadcastState(room);
}

/**
 * Fecha a sala agora, se ela ficou vazia (RN-SAL-20a).
 *
 * A carência de 12 s existe para a **queda**: recarregar a atividade desconecta
 * e reconecta, e sem ela quem estivesse sozinho perderia a sala a cada F5. Sair
 * de propósito é outra coisa — ali não há reconexão a esperar, e deixar a sala
 * de pé por mais 12 segundos só faz ela aparecer vazia na lista de quem está
 * olhando o lobby naquele instante.
 *
 * Só quem sai é que chama isto. A queda continua passando pelo varredor.
 */
export function closeIfEmpty(room: Room): void {
  if (room.viewers.size > 0 || room.broadcasters.size > 0) return;
  forget(room);
  console.log(`[room ${room.id}] fechada por quem saiu`);
}

export const stats = () =>
  [...rooms.values()].map((r) => ({
    id: r.id,
    name: r.name,
    locked: Boolean(r.password),
    broadcasting: r.broadcasters.size,
    viewers: r.viewers.size,
    droppedChunks: r.droppedChunks,
  }));
