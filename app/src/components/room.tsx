"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { Avatar } from "./avatar";
import { Grid } from "./grid";
import { Lobby, PasswordModal, ChangePasswordModal } from "./lobby";
import { ControlBar, RoundButton, Group, Icon } from "./controls";
import { Details } from "./details";
import { FeedbackModal } from "./feedback-modal";
import { ActionItem, CheckItem, Menu, Separator } from "./menu";
import { TileMenu } from "./tile-menu";
import { Modal } from "./modal";
import { BroadcastModal } from "./broadcast-modal";
import { Stage } from "./stage";
import { Profile } from "./profile";
import { Toast } from "./toast";
import { useDiscord } from "@/contexts/discord";
import Link from "next/link";

import { ApiError } from "@/lib/api";
import { normalizeName } from "@/lib/name";
import { RoomConnection } from "@/lib/room";
import {
  callRoom,
  createRoom,
  fixedRoom,
  guildRoom,
  setPassword,
  forgetTokens,
  joinRoom,
  listRooms,
  saveTokens,
  storedTokens,
  writeRoomInUrl,
} from "@/lib/rooms";
import {
  authDiscord,
  authGuest,
  clientIdOf,
  STORED_NAME,
  renewer,
  restoreSession,
  storedName,
  discardBadge,
  takeIdentityFromHash,
} from "@/lib/session";
import { remove, store } from "@/lib/storage";
import { readVolume, readVolumes, saveVolume } from "@/lib/volume";
import { useControlsVisible } from "@/lib/controls-visibility";
import { useShortcuts } from "@/lib/shortcuts";
import { popOut, supported as popoutSupported } from "@/lib/popout";
import {
  enterNative,
  nativeActive,
  listen as listenFullscreen,
  exitNative,
} from "@/lib/fullscreen";
import { DEFAULT_PRESET } from "@/lib/presets";
import { startBroadcast } from "@/lib/broadcast";
import type { Broadcaster } from "@/lib/broadcaster";
import { saveBadge } from "@/lib/session";
import type { RoomSummary, RoomTokens, Session, Person } from "@/lib/types";

/** Recarga do lobby (RF-SAL-4): salas abrem, enchem e fecham enquanto se olha. */
const RELOAD_MS = 4000;

/** Sem este vigia, uma espera que não termina fica com cara de "Conectando…" para sempre (RF-SES-8). */
const SLOW_MS = 8000;

export function Room({ guild, fixa }: { guild?: string; fixa?: string } = {}) {
  const { inDiscord, api, ws } = useDiscord();
  /**
   * Link de servidor ou link fixo: nos dois a sala é decidida pelo endereço,
   * não há lobby, e quando a sala some a pessoa volta para a mesma.
   */
  const byAddress = Boolean(guild || fixa);
  /** Para onde o login do Discord volta. */
  const backHere = fixa ? `/s/${fixa}` : `/${guild ?? ""}`;

  // useState com inicializador preguiçoso, e não useRef: a conexão é lida
  // durante a renderização (o useSyncExternalStore precisa dela ali), e ler
  // ref nesse momento é justamente o que o compilador do React proíbe.
  const [connection] = useState(() => new RoomConnection());
  const room = useSyncExternalStore(
    connection.subscribe,
    connection.getSnapshot,
    connection.getServerSnapshot
  );

  const [session, setSession] = useState<Session | null>(null);
  const [bootFailure, setBootFailure] = useState<string | null>(null);
  // Em `/<id do servidor>` não há caminho de convidado: sem conta do Discord
  // não há voz para consultar. Aqui a tela é de login, não de erro.
  const [needsLogin, setNeedsLogin] = useState(false);
  /** Link fixo aberto como convidado: oferece entrar com o Discord antes. */
  const [chooseIdentity, setChooseIdentity] = useState(false);
  /**
   * O link aponta para uma call, e a pessoa está noutra.
   *
   * Não é erro dela nem falta de permissão — é só o link errado para o momento.
   * Então em vez de "não deu para entrar", a saída oferecida é a call em que
   * ela **está**, que é o link padrão do servidor.
   */
  const [wrongCall, setWrongCall] = useState(false);
  /**
   * Saiu da conta estando num link de servidor.
   *
   * Ali não há lobby nem sala para criar: quem cria é a call. Então a tela diz
   * que saiu e oferece o caminho de volta, que refaz a validação inteira.
   */
  const [loggedOut, setLoggedOut] = useState(false);
  /**
   * A sala da call, resolvida e guardada — mas fora dela.
   *
   * Abrir `/<id>` **entra direto**: quem chega pelo link quer a sala, e uma
   * tela de confirmação no meio só custaria um clique.
   *
   * Ela aparece depois de sair, e é isso que impede o laço: você continua na
   * call, então sem esse estado o arranque colocaria você de volta no mesmo
   * instante. Os tokens ficam guardados aqui para reentrar sem consultar o
   * Discord de novo.
   */
  const [entrada, setEntrada] = useState<RoomTokens | null>(null);
  const [slow, setSlow] = useState(false);

  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [listed, setListed] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [askingPassword, setAskingPassword] = useState<RoomSummary | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [notice, setNotice] = useState<{
    text: string;
    error: boolean;
    action?: { label: string; onClick: () => void };
  } | null>(null);
  const [inRoom, setInRoom] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // Recolher as pessoas é preferência de quem assiste, então fica guardada
  // (RF-AST-14). Vive no snapshot da conexão pelo mesmo motivo do volume: ler
  // localStorage na renderização quebraria a hidratação.
  const showPeople = room.showPeople;
  // Qual tela está no palco quando o modo é foco. Fica aqui, e não na conexão,
  // porque se refere a uma transmissão específica — que não existe na próxima
  // visita (RN-AST-34).
  const [focused, setFocused] = useState<number | null>(null);
  // A fixação é da sessão, não guardada: ela se refere a uma transmissão
  // específica, que não existe na próxima visita (RN-AST-34).
  const [pinned, setPinned] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const controlsVisible = useControlsVisible(fullscreen);
  const [helpOpen, setHelpOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [poppedOut, setPoppedOut] = useState<number | null>(null);
  const popoutWindow = useRef<Window | null>(null);
  const [tileMenu, setTileMenu] = useState<{
    slot: number;
    userId: string;
    x: number;
    y: number;
  } | null>(null);
  const [tokens, setTokens] = useState<RoomTokens | null>(null);
  /**
   * Os mesmos tokens, numa ref.
   *
   * `leaveRoom` precisa deles, e lê-los do estado o fazia mudar de identidade a
   * cada entrada e saída. Isso subia a cadeia — `connect`, `enterGuildRoom` — e
   * chegava ao efeito de arranque, que rodava de novo e **reentrava na sala que
   * a pessoa acabara de deixar**.
   */
  const tokensRef = useRef<RoomTokens | null>(null);
  const [broadcastModal, setBroadcastModal] = useState(false);
  // Transmissão nascida aqui dentro, quando o Discord permite capturar no
  // iframe. A que roda na aba externa tem conexão própria e não aparece aqui.
  //
  // A instância fica na ref e o "estou no ar" num estado à parte: ler a ref
  // durante a renderização é o que o compilador do React proíbe, e o botão
  // precisa do valor justamente ali.
  // Tela e câmera são duas transmissões independentes (RF-CAM-3): cada uma
  // tem sua própria captura, sua própria opinião local de "estou no ar" e sua
  // própria mensagem de parada — nunca uma reação em cadeia entre as duas.
  const mineScreen = useRef<Broadcaster | null>(null);
  const mineCamera = useRef<Broadcaster | null>(null);
  /**
   * A intenção local sobre estar no ar: `null` = sem opinião, vale o servidor.
   *
   * Booleano puro não dá conta porque o botão precisa de duas garantias
   * opostas. Começando a transmitir, ele não pode piscar de volta para
   * "Compartilhar" no intervalo até o `state` chegar. Parando, ele não pode
   * voltar para "Parar de transmitir" — e voltava: a aba de captura só some do
   * `broadcasting` do servidor depois da ida e volta pelo relay, e o OU com o
   * estado do servidor ressuscitava o botão. Quem clicava via o clique não
   * fazer nada e clicava de novo.
   *
   * A opinião local vence enquanto existe, e é descartada ao começar uma
   * transmissão nova — que é quando ela pode ter envelhecido.
   */
  const [screenOnAirIntent, setScreenOnAirIntent] = useState<boolean | null>(null);
  const [cameraOnAirIntent, setCameraOnAirIntent] = useState<boolean | null>(null);
  // Para onde o botão de silenciar volta: sem isto, desmutar cairia sempre em
  // 100%, ignorando o ajuste que a pessoa tinha feito (RN-AUD-12).
  const volumeBeforeMute = useRef(1);

  const toast = useCallback((text: string, error = false) => setNotice({ text, error }), []);

  // Só alimenta a conexão com o que estava guardado; quem publica o valor para
  // a interface é ela, pelo snapshot.
  useEffect(() => {
    connection.loadVolumes(readVolume(), readVolumes());
  }, [connection]);

  /**
   * Entra e sai de tela cheia (RF-AST-4).
   *
   * Tenta a API nativa primeiro — fora do Discord é o que a pessoa espera, o
   * mesmo que o F11 faz. Dentro da Activity ela é negada por Permissions Policy
   * (RN-UI-8), e aí vale o layout (RN-AST-13).
   */
  const toggleFullscreen = useCallback(() => {
    void (async () => {
      if (fullscreen || nativeActive()) {
        if (!(await exitNative())) setFullscreen(false);
        return;
      }
      if (!(await enterNative())) setFullscreen(true);
    })();
  }, [fullscreen]);

  // O navegador também entra e sai por conta própria — o Esc, o F11, o botão da
  // barra dele. Assinar o evento mantém o nosso estado honesto.
  useEffect(() => listenFullscreen(() => setFullscreen(nativeActive())), []);

  /**
   * `Esc` sai da tela cheia por layout (RF-AST-4).
   *
   * O modal também escuta `Esc`, e por isso ele para a propagação: o de cima
   * fecha primeiro, e só quando não há modal a tecla chega aqui.
   */
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFullscreen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // ------------------------------------------------------------- entrar

  const renew = useCallback(() => {
    const params = new URLSearchParams(location.search);
    return renewer(inDiscord, clientIdOf(params), api, setSession)();
  }, [inDiscord, api]);

  /**
   * Parar a transmissão vem primeiro (RN-SAL-22).
   *
   * A captura da aba externa só para se o servidor avisar, e depois do close()
   * não sobra por onde avisar. Deixar a captura viva depois de sair é vazamento
   * de tela, não detalhe de interface.
   */
  const stopMyBroadcast = useCallback(
    (kind: "screen" | "camera") => {
      const mine = kind === "camera" ? mineCamera : mineScreen;
      mine.current?.stop();
      mine.current = null;
      (kind === "camera" ? setCameraOnAirIntent : setScreenOnAirIntent)(false);
      // A aba externa tem conexão própria: só o servidor consegue mandá-la
      // parar (RN-TRX-31), e ele encerra a de quem pediu, resolvida por uid e
      // por kind — tela e câmera se encerram sem se afetar (RF-CAM-3).
      connection.requestStop(kind);
    },
    [connection]
  );

  /**
   * Sai da sala e volta para a raiz certa.
   *
   * Num link de servidor, a raiz é a dele — a tela de entrada, que diz em qual
   * call você está e oferece abrir de novo. Fora dele, é a lista de salas de
   * convidado. Antes isto só limpava o estado e ficava na mesma URL, o que
   * deixava a pessoa numa tela que não era nem sala nem entrada.
   */
  const leaveRoom = useCallback(() => {
    stopMyBroadcast("screen");
    stopMyBroadcast("camera");
    connection.disconnect();
    writeRoomInUrl(null);
    setTokens(null);
    setInRoom(false);
    // O valor é lido **agora**, e não dentro do atualizador: o atualizador roda
    // depois, e a essa altura a ref já teria sido zerada — a tela de "você
    // saiu" ficava sem os tokens e caía no painel de "abrindo a sala".
    const lastTokens = tokensRef.current;
    tokensRef.current = null;
    // Guarda o que já foi resolvido: voltar não precisa consultar o Discord de
    // novo para saber qual é a call.
    if (byAddress && lastTokens) setEntrada((current) => current ?? lastTokens);
  }, [connection, stopMyBroadcast, byAddress]);

  /**
   * O ciclo entre entrar na call e conectar, quebrado.
   *
   * `conectar` precisa reentrar na call quando a sala some, e `entrarNaCall`
   * precisa de `conectar` para terminar. Declarar um dentro do outro é
   * impossível nos dois sentidos; a ref segura a versão mais recente e é lida
   * só dentro de um callback, nunca durante a renderização.
   */
  const rejoinCall = useRef<(() => void) | null>(null);

  const connect = useCallback(
    (tokens: RoomTokens) => {
      saveTokens(tokens);
      writeRoomInUrl(tokens.roomId);
      tokensRef.current = tokens;
      setTokens(tokens);
      setInRoom(true);

      connection.connect(ws, tokens, storedName(), {
        onError: (m) => toast(m, true),
        onStreamStart: (slot, userId, kind) => {
          // Sem som de notificação (RN-AST-33): um aviso sonoro numa página que
          // já toca o áudio de outra pessoa é ruído em cima de ruído.
          const quem = connection.getSnapshot().participants.find((p) => p.id === userId);
          const oQue = kind === "camera" ? "ligou a câmera" : "começou a compartilhar a tela";
          setNotice({
            text: `${quem?.name ?? "Alguém"} ${oQue}`,
            error: false,
            action: { label: "Assistir", onClick: () => connection.watch(slot) },
          });
        },
        onRoomGone: () => {
          forgetTokens(tokens.roomId);
          // Onde a sala é a da call — Activity ou link de servidor — ela é
          // recriada e a pessoa volta para ela (RF-SAL-7). Só no lobby é que
          // "a sala sumiu" significa mesmo perder o lugar.
          if (inDiscord || byAddress) {
            rejoinCall.current?.();
          } else {
            toast("A sala foi fechada.", true);
            leaveRoom();
          }
        },
        onRejected: () => {
          forgetTokens(tokens.roomId);
          toast("Sua sessão expirou. Entrando de novo…");
          if (inDiscord || byAddress) rejoinCall.current?.();
          else leaveRoom();
        },
      });
    },
    [connection, ws, inDiscord, byAddress, toast, leaveRoom]
  );

  /**
   * A identidade vem por argumento, e não do estado.
   *
   * Quem chama primeiro é o arranque, que ainda não terminou de guardar a
   * sessão no estado quando precisa entrar na sala da call — ler dali daria o
   * valor da renderização anterior, que é null.
   */
  const joinCallRoom = useCallback(
    async (identity: string) => {
      try {
        connect(await callRoom(api, identity, renew));
      } catch (err) {
        toast(err instanceof Error ? err.message : "Não consegui abrir a sala da call.", true);
      }
    },
    [api, renew, connect, toast]
  );

  /**
   * Entra na sala daquela call do servidor (`/<id>`).
   *
   * Quem responde em qual call a pessoa está é o Discord. Os três desfechos
   * têm textos diferentes de propósito: "entre numa call" é ação dela, "o bot
   * precisa estar no servidor" é ação de quem administra, e 401 é falta de
   * login — tratá-los igual manda a pessoa resolver o problema errado.
   */
  /** A call que o link pede, quando ele diz. */
  const requestedRoom = () => new URLSearchParams(location.search).get("room");

  const enterGuildRoom = useCallback(
    async (identity: string) => {
      if (fixa) {
        try {
          connect(await fixedRoom(api, identity, fixa, renew));
        } catch (err) {
          setBootFailure(err instanceof Error ? err.message : "Não consegui abrir a sala.");
        }
        return;
      }
      if (!guild) return;
      try {
        const requestedRoomId = requestedRoom();
        const tokens = await guildRoom(api, identity, guild, requestedRoomId, renew);
        // O servidor pode ter resolvido o apelido desta pessoa naquele servidor
        // do Discord; é por ele que a galera dali a reconhece.
        if (tokens.user) {
          setSession((current) => (current ? { ...current, user: tokens.user as Person } : current));
        }
        connect(tokens);
      } catch (err) {
        if (err instanceof ApiError && err.code === "outra-call") {
          setWrongCall(true);
          return;
        }
        setBootFailure(
          err instanceof Error ? err.message : "Não consegui abrir a sala deste servidor."
        );
      }
    },
    [guild, fixa, api, renew, connect]
  );

  /**
   * A sala que o convite pede, em `/?room=<id>` (RF-SAL-8).
   *
   * Quem recebe um link espera cair dentro da sala, não no lobby com a lista
   * aberta para procurar qual delas era. O parâmetro **não dá acesso**: sala
   * com senha continua pedindo a senha, e o que o link poupa é a garimpagem,
   * nunca a autorização (RN-SAL-4).
   *
   * O `uid` vem por argumento pelo mesmo motivo da identidade em
   * `joinCallRoom`: no arranque a sessão ainda não chegou ao estado.
   */
  const enterLinkedRoom = useCallback(
    async (identity: string, uid: string) => {
      const requested = requestedRoom();
      if (!requested) return;

      // Numa visita seguinte o token guardado entra sem pedir a senha de novo.
      const stored = storedTokens(requested, uid);
      if (stored) {
        connect(stored);
        return;
      }

      try {
        connect(await joinRoom(api, { identity, roomId: requested }, renew));
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 0;

        // 403 senha, 429 bloqueio: o modal assume e conclui a entrada. Ele
        // mostra o nome da sala, que o link não carrega — daí a consulta à
        // lista. Se ela falhar ou a sala não estiver nela, o modal ainda
        // funciona: o que ele precisa mesmo é do id.
        if (status === 403 || status === 429) {
          const achada = await listRooms(api, identity)
            .then(({ rooms }) => rooms.find((r) => r.id === requested) ?? null)
            .catch(() => null);
          setAskingPassword(
            achada ?? {
              id: requested,
              name: "Sala protegida",
              owner: "",
              isCall: false,
              locked: true,
              people: 0,
              streams: 0,
            }
          );
          return;
        }

        // 404: o convite é de uma sala que já fechou. Tirar o `?room=` da barra
        // evita que recarregar a página repita o erro para sempre.
        if (status === 404) {
          forgetTokens(requested);
          writeRoomInUrl(null);
          toast("Essa sala não existe mais.", true);
          return;
        }
        toast(err instanceof Error ? err.message : "Não consegui abrir a sala do convite.", true);
      }
    },
    [api, renew, connect, toast]
  );

  useEffect(() => {
    rejoinCall.current = session
      ? () => void (byAddress ? enterGuildRoom(session.identity) : joinCallRoom(session.identity))
      : null;
  }, [joinCallRoom, enterGuildRoom, byAddress, session]);

  // ------------------------------------------------------------- arranque

  /**
   * O arranque.
   *
   * As dependências abaixo são todas estáveis de propósito: se qualquer uma
   * mudar de identidade, este efeito roda de novo — e rodar de novo significa
   * **entrar na sala outra vez**, inclusive numa que a pessoa acabou de
   * deixar. Foi esse o caminho do laço que os tokens em `useState` abriam.
   *
   * Uma trava de "já arranquei" não serve aqui: em desenvolvimento o React
   * monta o efeito duas vezes, e a trava barraria a segunda passagem — a
   * primeira já foi cancelada pelo `alive`, e a sessão nunca chegaria.
   */
  useEffect(() => {
    let alive = true;
    const watchdog = setTimeout(() => alive && setSlow(true), SLOW_MS);

    (async () => {
      try {
        // O crachá do callback do OAuth chega no fragmento e é apagado da barra
        // de endereço na leitura (RN-SES-9).
        takeIdentityFromHash();

        const params = new URLSearchParams(location.search);
        const clientId = clientIdOf(params);

        /*
         * Dentro da Activity a identidade é **sempre** refeita pelo Discord.
         *
         * Restaurar do armazenamento ali seria reusar um crachá emitido para
         * outra instância — a de uma sessão web, ou a de um lançamento anterior
         * da atividade —, e o `instance` dele decide em que sala da call a
         * pessoa entra (RN-SAL-3). O sintoma seria entrar na sala errada, ou em
         * nenhuma, sem nada acusando.
         *
         * Fora do Discord vale o contrário: o crachá guardado evita uma ida à
         * rede no arranque e mantém a mesma identidade entre recargas.
         */
        let fresh: Session;
        if (inDiscord) {
          if (!clientId) {
            throw new Error(
              "O servidor está sem as credenciais do Discord. Preencha DISCORD_CLIENT_ID no .env."
            );
          }
          fresh = await authDiscord(clientId, api);
        } else {
          fresh = restoreSession() ?? (await authGuest(api));
        }

        if (!alive) return;
        saveBadge(fresh.identity);
        setSession(fresh);

        // Dentro do Discord não há lobby: a atividade entra direto na sala
        // daquela call (RN-SAL-1). Fica aqui, e não num efeito que observa a
        // sessão, porque entrar é parte do arranque — um efeito reativo faria
        // a entrada depender de uma renderização a mais e devolveria uma
        // cascata de re-render a cada mudança de sessão.
        if (inDiscord) await joinCallRoom(fresh.identity);
        else if (fixa) {
          // Convidado vê a escolha antes (uma vez por aba): entrar com o
          // Discord traz nome e foto; convidado entra na hora.
          let decided = false;
          try {
            decided = sessionStorage.getItem("fixaComoConvidado") === "1";
          } catch {
            // armazenamento indisponível: pergunta de novo, sem problema
          }
          if (fresh.user.id.startsWith("guest-") && !decided) setChooseIdentity(true);
          else await enterGuildRoom(fresh.identity);
        } else if (guild) {
          if (fresh.user.id.startsWith("guest-")) setNeedsLogin(true);
          else await enterGuildRoom(fresh.identity);
        }
        // Fora do Discord e fora de um servidor, um `?room=` na barra é um
        // convite colado: entra direto, em vez de mostrar o lobby por trás.
        else await enterLinkedRoom(fresh.identity, fresh.user.id);
      } catch (err) {
        if (!alive) return;
        setBootFailure(
          err instanceof Error ? err.message : "Não foi possível iniciar a sessão."
        );
      } finally {
        clearTimeout(watchdog);
        if (alive) setSlow(false);
      }
    })();

    return () => {
      alive = false;
      clearTimeout(watchdog);
    };
  }, [inDiscord, api, joinCallRoom, enterGuildRoom, enterLinkedRoom, guild, fixa]);

  // ------------------------------------------------------------- o lobby

  useEffect(() => {
    if (inDiscord || byAddress || inRoom) return;

    let alive = true;
    const refresh = async () => {
      // A recarga pausa enquanto houver modal aberto: recarregar sob o cursor
      // tiraria o card do lugar no meio de um clique (RN-SAL-13).
      if (modalOpen || askingPassword) return;
      try {
        const { rooms } = await listRooms(api, session?.identity ?? null);
        if (alive) {
          setRooms(rooms);
          setListed(true);
        }
      } catch {
        // Lista que falha não tira ninguém da tela; a próxima volta em 4 s.
      }
    };

    void refresh();
    const t = setInterval(refresh, RELOAD_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [inDiscord, byAddress, inRoom, modalOpen, askingPassword, api, session]);

  async function handleEnter(target: RoomSummary, password?: string) {
    if (!session) return;

    // Token guardado primeiro: numa visita seguinte entra sem pedir a senha de
    // novo (RF-SAL-9). Se ele falhar, o fluxo normal assume.
    const stored = storedTokens(target.id, session.user.id);
    if (stored && password === undefined) {
      connect(stored);
      return;
    }

    try {
      const tokens = await joinRoom(
        api,
        password === undefined
          ? { identity: session.identity, roomId: target.id }
          : { identity: session.identity, roomId: target.id, password: password },
        renew
      );
      setAskingPassword(null);
      setPasswordError(null);
      connect(tokens);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      const text = err instanceof Error ? err.message : "Não consegui entrar.";

      // 403 senha, 429 bloqueio: os dois abrem o modal de senha, mas com textos
      // diferentes — a recusa por bloqueio diz quantos segundos faltam.
      if (status === 403 || status === 429) {
        setAskingPassword(target);
        setPasswordError(password === undefined ? null : text);
        return;
      }
      // 404: a sala fechou. Limpa o token guardado e recarrega a lista.
      if (status === 404) forgetTokens(target.id);
      toast(text, true);
    }
  }

  async function handleCreate(name: string, password: string) {
    if (!session) return;
    setModalOpen(false);
    try {
      connect(
        await createRoom(
          api,
          password
            ? { identity: session.identity, name: name, password: password }
            : { identity: session.identity, name: name },
          renew
        )
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : "Não consegui criar a sala.", true);
    }
  }

  /**
   * Estou transmitindo?
   *
   * A transmissão local entra no OU porque o `state` leva um instante para
   * chegar, e sem isso o botão pisca de volta para "Compartilhar" logo depois
   * de começar.
   */
  // Quem está no palco agora — é o nome que o cabeçalho anuncia.
  const onStage = room.streams[0]
    ? (room.participants.find((p) => p.id === room.streams[0]?.userId) ?? null)
    : null;
  // Tela e câmera têm o mesmo palco (RF-CAM-1): o cabeçalho precisa dizer
  // qual das duas está ali, e não sempre "tela".
  const onStageKind = room.streams[0]?.kind ?? "screen";

  // A verdade do servidor já distingue por kind (RF-CAM-3): cada entrada de
  // `room.streams` é uma transmissão, e a minha aparece com o meu uid uma vez
  // para tela e, se estiver ligada, outra vez para câmera.
  const iAmOnAirScreen =
    screenOnAirIntent ??
    room.streams.some((s) => s.kind === "screen" && s.userId === session?.user.id);
  const iAmOnAirCamera =
    cameraOnAirIntent ??
    room.streams.some((s) => s.kind === "camera" && s.userId === session?.user.id);

  async function share(preset: typeof DEFAULT_PRESET, source: "screen" | "camera" = "screen") {
    setBroadcastModal(false);
    if (!tokens) return;
    const mine = source === "camera" ? mineCamera : mineScreen;
    const setIntent = source === "camera" ? setCameraOnAirIntent : setScreenOnAirIntent;
    // Opinião velha ("acabei de parar") não pode sobreviver a um começo novo.
    setIntent(null);

    const r = await startBroadcast(tokens, preset, source, ws, {
      onEnd: (reason) => {
        mine.current = null;
        setIntent(false);
        if (reason) toast(reason);
      },
      onNotice: (m) => toast(m),
    });

    if (r.kind === "iframe") {
      mine.current = r.broadcaster;
      setIntent(true);
    }
    else if (r.kind === "tab") toast("Abri a aba de captura. Deixe-a aberta enquanto transmite.");
    else if (r.kind === "refused") toast(r.message, true);
  }

  /**
   * Sai da conta do Discord e volta a ser convidado (RF-SES-9).
   *
   * Descarta o crachá e o apelido escolhido, e emite uma identidade nova de
   * convidado. Os tokens de sala guardados morrem junto: eles carregam o `uid`
   * de quem os pediu, e reusá-los com outra identidade colocaria a pessoa na
   * sala com o nome antigo.
   */
  const logout = useCallback(async () => {
    discardBadge();
    remove(STORED_NAME);
    leaveRoom();
    setProfileOpen(false);

    // No link de servidor não existe caminho de convidado: a tela vira o aviso
    // de que saiu, com o botão que refaz a validação do zero.
    if (guild) {
      writeRoomInUrl(null);
      setSession(null);
      setLoggedOut(true);
      return;
    }

    try {
      const guest = await authGuest(api);
      saveBadge(guest.identity);
      setSession(guest);
      // No link fixo não há lobby para onde voltar: a tela de escolha volta.
      if (fixa) {
        setEntrada(null);
        setChooseIdentity(true);
      }
    } catch {
      setBootFailure("Saí da conta, mas não consegui abrir uma sessão de convidado.");
    }
  }, [api, guild, fixa, leaveRoom]);

  function renameSelf(name: string) {
    const clean = normalizeName(name);
    if (!clean) return;
    store(STORED_NAME, clean);
    connection.rename(clean);
    setSession((current) => (current ? { ...current, user: { ...current.user, name: clean } } : current));
  }

  const toggleMute = useCallback(() => {
    const v = room.volume === 0 ? volumeBeforeMute.current || 1 : 0;
    if (room.volume > 0) volumeBeforeMute.current = room.volume;
    saveVolume(v);
    connection.setVolume(v);
  }, [connection, room.volume]);

  useShortcuts(inRoom, {
    fullscreen: toggleFullscreen,
    mute: toggleMute,
    mode: () => connection.setMode(room.mode === "grid" ? "focus" : "grid"),
    people: () => connection.setShowPeople(!showPeople),
    toStage: (i) => {
      const target = room.streams[i];
      if (!target) return;
      setFocused(target.slot);
      connection.setMode("focus");
    },
    help: () => setHelpOpen(true),
  });

  /**
   * Destaca a tela numa janela sempre-no-topo, ou traz de volta.
   *
   * O canvas é um nó só (RN-AST-17): destacar o move para lá, e fechar a janela
   * o devolve ao tile na renderização seguinte.
   */
  const togglePopout = useCallback(
    (slot: number) => {
      if (poppedOut !== null) {
        popoutWindow.current?.close();
        popoutWindow.current = null;
        setPoppedOut(null);
        return;
      }
      const canvas = connection.canvasFor(slot);
      if (!canvas) return;
      void popOut(canvas, () => {
        popoutWindow.current = null;
        setPoppedOut(null);
      }).then((j) => {
        popoutWindow.current = j;
        if (j) setPoppedOut(slot);
      });
    },
    [connection, poppedOut]
  );

  // ------------------------------------------------------------- desenho

  if (entrada && !inRoom) {
    return (
      <main className="grid h-dvh place-items-center p-respiro text-center">
        <div className="max-w-md">
          <p className="text-[13px] text-suave">Você saiu da sala</p>
          <h1 className="mt-1 text-xl font-semibold text-texto">
            {entrada.roomName ?? "Sala da call"}
          </h1>
          <p className="mt-2 text-suave">
            {fixa
              ? "Pode voltar quando quiser — o link continua o mesmo."
              : "Você continua na call do Discord. Pode voltar quando quiser."}
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Link
              href="/"
              className="inline-block rounded-full bg-tile px-5 py-2.5 text-[14px]/none font-medium text-texto hover:bg-tile-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-texto"
            >
              Salas de convidados
            </Link>
            <button
              type="button"
              onClick={() => {
                // Tokens novos, e não os guardados: se você era o último a
                // sair, a sala foi dissolvida na hora (RN-SAL-20a) e o token
                // antigo aponta para algo que não existe mais. Reentrar é o
                // mesmo caminho de entrar — perguntar ao Discord onde você
                // está.
                setEntrada(null);
                if (session) void enterGuildRoom(session.identity);
              }}
              className="rounded-full bg-acento px-5 py-2.5 text-[14px]/none font-medium text-white hover:bg-acento-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-texto"
            >
              Voltar para a sala
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (loggedOut) {
    return (
      <main className="grid h-dvh place-items-center p-respiro text-center">
        <div className="max-w-md">
          <h1 className="text-lg font-semibold text-texto">Você saiu da conta</h1>
          <p className="mt-1 text-suave">
            A sala deste servidor é a da call em que você está, então ela precisa saber quem você é
            no Discord.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {/* A saída para quem não quer voltar ao servidor: a raiz aceita
                convidado, e é lá que dá para criar sala à mão. */}
            <Link
              href="/"
              className="inline-block rounded-full bg-tile px-5 py-2.5 text-[14px]/none font-medium text-texto hover:bg-tile-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-texto"
            >
              Salas de convidados
            </Link>
            <a
              href={`/auth/login?goBack=${encodeURIComponent(backHere)}`}
              className="inline-block rounded-full bg-acento px-5 py-2.5 text-[14px]/none font-medium text-white hover:bg-acento-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-texto"
            >
              Voltar para a sala
            </a>
          </div>
        </div>
      </main>
    );
  }

  if (wrongCall) {
    return (
      <main className="grid h-dvh place-items-center p-respiro text-center">
        <div className="max-w-md">
          <h1 className="text-lg font-semibold text-texto">Esse link é de outra call</h1>
          <p className="mt-1 text-suave">
            Você está numa call diferente da que esse convite aponta. Quer abrir a sala da call em
            que você está?
          </p>
          <a
            href={`/${guild ?? ""}`}
            className="mt-4 inline-block rounded-full bg-acento px-5 py-2.5 text-[14px]/none font-medium text-white hover:bg-acento-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-texto"
          >
            Abrir a sala da minha call
          </a>
          <p className="mt-3 text-[13px] text-suave">
            Se você queria mesmo a call do convite, entre no canal de voz dela e abra o link de
            novo.
          </p>
        </div>
      </main>
    );
  }

  if (chooseIdentity && session) {
    return (
      <main className="grid h-dvh place-items-center p-respiro text-center">
        <div className="max-w-md">
          <p className="text-[13px] text-suave">Sala</p>
          <h1 className="mt-1 text-xl font-semibold text-texto">
            {fixa ? fixa.replace(/-+/g, " ").replace(/^./, (c) => c.toUpperCase()) : "Sala"}
          </h1>
          <p className="mt-2 text-suave">
            Entre com o Discord para aparecer com seu nome e sua foto, ou entre como convidado.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => {
                try {
                  sessionStorage.setItem("fixaComoConvidado", "1");
                } catch {
                  // sem armazenamento, só não lembra a escolha
                }
                setChooseIdentity(false);
                void enterGuildRoom(session.identity);
              }}
              className="rounded-full bg-tile px-5 py-2.5 text-[14px]/none font-medium text-texto hover:bg-tile-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-texto"
            >
              Entrar como convidado
            </button>
            <a
              href={`/auth/login?goBack=${encodeURIComponent(backHere)}`}
              className="inline-block rounded-full bg-acento px-5 py-2.5 text-[14px]/none font-medium text-white hover:bg-acento-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-texto"
            >
              Entrar com Discord
            </a>
          </div>
        </div>
      </main>
    );
  }

  if (needsLogin) {
    return (
      <main className="grid h-dvh place-items-center p-respiro text-center">
        <div>
          <h1 className="text-lg font-semibold text-texto">Entre com o Discord</h1>
          <p className="mt-1 text-suave">
            Para abrir a sala deste servidor eu preciso saber em qual call você está.
          </p>
          <a
            href={`/auth/login?goBack=${encodeURIComponent(`/${guild ?? ""}`)}`}
            className="mt-4 inline-block rounded-full bg-acento px-5 py-2.5 text-[14px]/none font-medium text-white hover:bg-acento-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-texto"
          >
            Entrar com Discord
          </a>
        </div>
      </main>
    );
  }

  if (bootFailure) {
    return (
      <main className="grid h-dvh place-items-center p-respiro text-center">
        <div>
          <p className="text-lg font-semibold text-texto">Não deu para entrar</p>
          <p className="mt-1 text-suave">{bootFailure}</p>
          {/* Entrar na call é ação de quem está lendo isto, então o caminho de
              volta fica aqui — sem recarregar a página (RN-SES-3). E a saída
              para a raiz também: sem ela esta tela é um beco, e a única forma
              de sair seria editar o endereço. */}
          {byAddress && session ? (
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Link
                href="/"
                className="inline-block rounded-full bg-tile px-5 py-2.5 text-[14px]/none font-medium text-texto hover:bg-tile-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-texto"
              >
                Salas de convidados
              </Link>
              <button
                type="button"
                onClick={() => {
                  setBootFailure(null);
                  void enterGuildRoom(session.identity);
                }}
                className="rounded-full bg-acento px-5 py-2.5 text-[14px]/none font-medium text-white hover:bg-acento-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-texto"
              >
                Tentar de novo
              </button>
            </div>
          ) : null}
        </div>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="grid h-dvh place-items-center p-respiro text-center">
        {slow ? (
          <Panel title="Está demorando…" text="Sem resposta do servidor. Ele está no ar?" />
        ) : (
          <Panel title="Conectando…" text="Preparando a sua sessão." />
        )}
      </main>
    );
  }

  const eu = session.user;
  const source = eu.id.startsWith("guest-") ? "modo local" : `Discord · ${eu.id}`;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/*
        A barra de cima carrega só metadado, como a do Discord: onde estamos,
        de quem é a tela no palco, e em que qualidade ela está indo. Os
        controles ficam embaixo, flutuando — ver componentes/controles.tsx.
      */}
      <header
        className={
          "flex shrink-0 items-center gap-3 px-respiro transition-all duration-200 " +
          (fullscreen && !controlsVisible ? "h-0 overflow-hidden opacity-0" : "h-[52px]")
        }
      >
        {inRoom && room.room ? (
          <span className="flex min-w-0 items-center gap-2 text-[14px] font-medium text-texto">
            <span className="truncate">
              {room.room.locked ? "🔒 " : ""}
              {room.room.name}
            </span>
            {onStage ? (
              <>
                <span aria-hidden="true" className="text-suave">
                  ·
                </span>
                <Avatar
                  id={onStage.id}
                  name={onStage.name}
                  avatar={onStage.avatar}
                  className="w-5! text-[9px]!"
                />
                <span className="truncate text-suave">
                  {onStageKind === "camera" ? "Câmera" : "Tela"} de {onStage.name}
                </span>
              </>
            ) : null}
          </span>
        ) : null}

        <span className="flex-1" />

        {/* O chip de qualidade e o selo de no ar, como no Discord. */}
        {iAmOnAirScreen || iAmOnAirCamera ? (
          <>
            {iAmOnAirScreen ? (
              <span className="rounded bg-tile px-2 py-1 text-[11px] font-semibold tracking-wide text-texto">
                {DEFAULT_PRESET.summary.replace(" · ", " ").toUpperCase()}
              </span>
            ) : null}
            <span className="rounded bg-perigo-solido px-2 py-1 text-[11px] font-semibold tracking-wide text-white">
              AO VIVO
            </span>
          </>
        ) : null}

        <button
          type="button"
          onClick={() => setProfileOpen(true)}
          // Sem aria-label: o nome vem do conteúdo, e o rótulo visível ("C9
          // Convidado 9325", com as iniciais do avatar) tem que estar contido
          // no nome acessível (WCAG 2.5.3) — qualquer aria-label divergia disso.
          className="flex items-center gap-2 rounded-full px-2 py-1 hover:bg-tile focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-texto"
        >
          <Avatar id={eu.id} name={eu.name} avatar={eu.avatar} className="w-7! text-[11px]!" />
          <span className="max-w-[20ch] truncate text-[13px] text-suave">{eu.name}</span>
          <span className="sr-only"> · Seu perfil</span>
        </button>
      </header>

      {/* A faixa de baixo é reservada para a barra flutuante: sem ela, os
          controles cobrem o rodapé dos tiles e o nome de quem está neles. */}
      <main className={`relative min-h-0 flex-1 ${inRoom ? "pb-[76px]" : ""}`}>
        {inRoom ? (
          room.mode === "focus" && room.streams.length > 0 ? (
            <Stage
              room={room}
              connection={connection}
              myId={eu.id}
              fullscreen={fullscreen}
              showWithoutVideo={showPeople}
              focused={focused}
              pinned={pinned}
              onFocus={setFocused}
              onUnpin={() => setPinned(null)}
              onMenu={(slot, userId, x, y) => setTileMenu({ slot, userId, x, y })}
              poppedOut={poppedOut}
            />
          ) : room.streams.length > 0 || room.participants.length > 0 ? (
            <Grid
              room={room}
              connection={connection}
              myId={eu.id}
              showWithoutVideo={showPeople}
              onFocus={(slot) => {
                setFocused(slot);
                connection.setMode("focus");
              }}
              onMenu={(slot, userId, x, y) => setTileMenu({ slot, userId, x, y })}
              poppedOut={poppedOut}
            />
          ) : (
            <Panel
              title={room.phase === "down" ? "Reconectando…" : "Ninguém na sala"}
              text={
                room.phase === "down"
                  ? "A conexão com a sala caiu."
                  : "Aguardando participantes."
              }
            />
          )
        ) : fixa ? (
          <Panel title="Abrindo a sala…" text="Só um instante." />
        ) : guild ? (
          // No link de servidor nunca há lobby: a sala é a da call, criada
          // sozinha por quem entra nela. Oferecer "criar sala" aqui daria uma
          // sala que ninguém daquele canal encontraria.
          <Panel
            title="Abrindo a sala da sua call…"
            text="Estou perguntando ao Discord em qual canal de voz você está."
          />
        ) : (
          <Lobby
            rooms={rooms}
            loading={!listed}
            onEnter={(s) => void handleEnter(s)}
            onCreate={(n, s) => void handleCreate(n, s)}
            onModalOpen={setModalOpen}
          />
        )}

        {askingPassword ? (
          <PasswordModal
            room={askingPassword}
            error={passwordError}
            onClose={() => {
              setAskingPassword(null);
              setPasswordError(null);
            }}
            onSubmit={(password) => void handleEnter(askingPassword, password)}
          />
        ) : null}

        {broadcastModal ? (
          <BroadcastModal
            onClose={() => setBroadcastModal(false)}
            onConfirm={(preset) => void share(preset, "screen")}
          />
        ) : null}

        {helpOpen ? (
          <Modal
            title="Atalhos"
            sub="Nenhum deles é o único caminho: tudo aqui também tem botão."
            onClose={() => setHelpOpen(false)}
          >
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[14px]">
              {[
                ["Esc", "fecha o modal ou sai da tela cheia"],
                ["F", "alterna tela cheia"],
                ["M", "silencia e devolve o som"],
                ["G", "alterna grade e foco"],
                ["P", "recolhe ou mostra as pessoas"],
                ["1–4", "põe aquela tela no palco"],
                ["?", "abre esta lista"],
              ].map(([key, what]) => (
                <Fragment key={key}>
                  <dt className="rounded border border-linha bg-tile px-1.5 py-0.5 text-center font-mono text-[12px] text-texto">
                    {key}
                  </dt>
                  <dd className="text-suave">{what}</dd>
                </Fragment>
              ))}
            </dl>
          </Modal>
        ) : null}

        {passwordOpen && room.room ? (
          <ChangePasswordModal
            hasPassword={room.room.locked}
            onClose={() => setPasswordOpen(false)}
            onSave={(password) => {
              setPasswordOpen(false);
              void setPassword(api, { identity: session.identity, roomId: room.room!.id, password: password }, renew)
                .then((r) => toast(r.locked ? "Senha definida." : "Senha removida."))
                .catch((err: unknown) =>
                  toast(err instanceof Error ? err.message : "Não consegui salvar.", true)
                );
            }}
          />
        ) : null}

        {/* A aba de feedback: colada na borda direita, no meio da altura, como nos
            sites que têm esse atalho — e fixada no topo, logo abaixo do cabeçalho,
            em telas estreitas (abaixo de 720 px), onde o meio da altura fica em cima do
            vídeo e dos tiles. Fica acima do palco e abaixo dos modais e
            do aviso (z-10 contra z-20), e some junto dos controles em tela cheia —
            senão ela seria a única coisa na tela depois de a barra recolher. */}
        <button
          type="button"
          onClick={() => setFeedbackOpen(true)}
          aria-label="Enviar feedback"
          title="Enviar feedback ou relatar um bug"
          className={
            "fixed top-1/2 right-0 z-10 flex -translate-y-1/2 max-[720px]:top-[60px] max-[720px]:translate-y-0 flex-col items-center gap-2 rounded-l-xl bg-acento px-2 py-3 text-[13px]/none font-medium text-white shadow-[0_4px_16px_rgba(0,0,0,0.45)] transition-[opacity,padding] duration-200 hover:bg-acento-hover hover:pr-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-texto [&_svg]:size-[18px] [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:[stroke-width:1.8] [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round]" +
            (inRoom && !controlsVisible ? " pointer-events-none opacity-0" : " opacity-100")
          }
        >
          <Icon.Feedback />
          <span aria-hidden="true" className="[text-orientation:mixed] [writing-mode:vertical-rl]">
            Feedback
          </span>
        </button>

        {feedbackOpen ? (
          <FeedbackModal
            url={api("/api/feedback")}
            identity={session?.identity ?? null}
            name={eu.name}
            roomId={inRoom ? (tokens?.roomId ?? null) : null}
            where={feedbackWhere(inRoom)}
            onClose={() => setFeedbackOpen(false)}
          />
        ) : null}

        {profileOpen ? (
          <Profile
            user={eu}
            source={source}
            onSave={renameSelf}
            {...(eu.id.startsWith("guest-") ? {} : { onLogout: () => void logout() })}
            onClose={() => setProfileOpen(false)}
          />
        ) : null}
        {/* Os controles pairam sobre a tela, ao centro de baixo, e o alternar
            de tela cheia fica no canto — a geometria do Discord. */}
        {inRoom ? (
          <div
            data-controls
            className={
              "pointer-events-none absolute inset-x-0 bottom-4 flex justify-center transition-opacity duration-200 " +
              (controlsVisible ? "opacity-100" : "pointer-events-none opacity-0")
            }
          >
            <ControlBar>
              <Group>
                <RoundButton
                  label={iAmOnAirScreen ? "Parar de transmitir" : "Compartilhar tela"}
                  state={iAmOnAirScreen ? "active" : "neutral"}
                  onClick={() => (iAmOnAirScreen ? stopMyBroadcast("screen") : setBroadcastModal(true))}
                >
                  {iAmOnAirScreen ? <Icon.Stop /> : <Icon.Screen />}
                </RoundButton>

                {/* Independente da tela (RF-CAM-1): as duas ligam e desligam
                    sem se afetar, e dá para as duas estarem no ar juntas. */}
                <RoundButton
                  label={iAmOnAirCamera ? "Desligar câmera" : "Ligar câmera"}
                  state={iAmOnAirCamera ? "active" : "neutral"}
                  onClick={() =>
                    iAmOnAirCamera ? stopMyBroadcast("camera") : void share(DEFAULT_PRESET, "camera")
                  }
                >
                  {iAmOnAirCamera ? <Icon.CameraOff /> : <Icon.Camera />}
                </RoundButton>

                {/* Só existe quando há som para controlar (RN-AUD-14). */}
                {room.withSound.length > 0 ? (
                  <label className="flex items-center gap-2 pr-2 pl-1">
                    <span className="sr-only">Volume geral</span>
                    <RoundButton
                      label={room.volume === 0 ? "Tirar do mudo" : "Silenciar"}
                      // O mudo é zero no volume geral — um número só, em vez de
                      // dois estados que precisam concordar (RN-AUD-12).
                      onClick={toggleMute}
                    >
                      {room.volume === 0 ? <Icon.Muted /> : <Icon.Sound />}
                    </RoundButton>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={room.volume}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        saveVolume(v);
                        connection.setVolume(v);
                      }}
                      // Em telas estreitas o cursor sai e fica só o botão de mudo: com ele, o
                      // dock passava da largura da tela (o "Sair da sala" ficava para fora
                      // em 390 px), e no celular o volume do aparelho já faz esse papel.
                      className="w-24 accent-acento max-[480px]:hidden"
                    />
                  </label>
                ) : null}
                <span className="relative">
                  <RoundButton label="Mais opções" onClick={() => setMenuOpen((v) => !v)}>
                    <Icon.More />
                  </RoundButton>

                  {menuOpen ? (
                    <Menu onClose={() => setMenuOpen(false)}>
                      {/* Sem transmissão a grade é o único layout possível, e
                          a box marcaria uma escolha que não vale — pior que
                          não oferecer a escolha. */}
                      {room.streams.length > 0 ? (
                        <CheckItem
                          label="Exibição em grade"
                          checked={room.mode === "grid"}
                          onToggle={() =>
                            connection.setMode(room.mode === "grid" ? "focus" : "grid")
                          }
                        />
                      ) : null}
                      <CheckItem
                        label="Participantes sem vídeo"
                        checked={showPeople}
                        onToggle={() => connection.setShowPeople(!showPeople)}
                      />
                      <Separator />
                      {/* Só o dono troca a senha. O servidor confere de novo
                          (RN-SAL-15); esconder aqui é conveniência. */}
                      {room.room?.ownerId === eu.id ? (
                        <ActionItem
                          label="Senha da sala"
                          onClick={() => {
                            setMenuOpen(false);
                            setPasswordOpen(true);
                          }}
                        />
                      ) : null}
                      <ActionItem
                        label="Detalhes da conexão"
                        onClick={() => {
                          setMenuOpen(false);
                          setDetails(true);
                        }}
                      />
                      <ActionItem
                        label="Seu perfil"
                        onClick={() => {
                          setMenuOpen(false);
                          setProfileOpen(true);
                        }}
                      />
                      <ActionItem
                        label="Enviar feedback"
                        onClick={() => {
                          setMenuOpen(false);
                          setFeedbackOpen(true);
                        }}
                      />
                    </Menu>
                  ) : null}
                </span>
              </Group>

              {/* Dentro do Discord não há botão de sair: quem fecha a atividade
                  é o próprio Discord (RN-SAL-23). */}
              {inDiscord ? null : (
                <RoundButton label="Sair da sala" state="end" wide onClick={leaveRoom}>
                  <Icon.Leave />
                </RoundButton>
              )}
            </ControlBar>
          </div>
        ) : null}

        {details ? (
          <Details
            room={room}
            connection={connection}
            // O do palco, ou o primeiro que se está assistindo (RN-AST-23).
            slot={
              room.watching.includes(focused ?? -1)
                ? focused
                : (room.watching[0] ?? null)
            }
            onClose={() => setDetails(false)}
          />
        ) : null}

        {inRoom && room.streams.length > 0 ? (
          <div
            data-controls
            className={
              // Em telas estreitas sobe para logo acima do dock: lado a lado eles se
              // cruzavam (o "Sair da sala" ficava coberto por estes dois botões).
              "absolute right-4 bottom-4 max-[720px]:bottom-[76px] transition-opacity duration-200 " +
              (controlsVisible ? "opacity-100" : "pointer-events-none opacity-0")
            }
          >
            <span className="flex items-center gap-2">
              {/* Sem suporte, o botão não aparece (RN-AST-37): uma janela sem
                  sempre-no-topo não resolve o problema que a pessoa tinha. */}
              {popoutSupported() && room.watching.length > 0 ? (
                <RoundButton
                  label={poppedOut !== null ? "Trazer de volta" : "Destacar em outra janela"}
                  onClick={() => togglePopout(poppedOut ?? (room.watching[0] as number))}
                >
                  <Icon.Popout />
                </RoundButton>
              ) : null}

              <RoundButton
                // O rótulo muda com o estado: anunciar sempre a mesma coisa
                // mentiria para quem usa leitor de tela (RN-AST-15).
                label={fullscreen ? "Sair da tela cheia" : "Tela cheia"}
                onClick={toggleFullscreen}
              >
                {fullscreen ? <Icon.ExitFullscreen /> : <Icon.Fullscreen />}
              </RoundButton>
            </span>
          </div>
        ) : null}
      </main>

      {tileMenu ? (
        <TileMenu
          name={room.participants.find((p) => p.id === tileMenu.userId)?.name ?? "essa pessoa"}
          userId={tileMenu.userId}
          connection={connection}
          hasSound={room.withSound.includes(tileMenu.slot)}
          pinned={pinned === tileMenu.slot}
          onPin={() => {
            setPinned(pinned === tileMenu.slot ? null : tileMenu.slot);
            setTileMenu(null);
          }}
          x={tileMenu.x}
          y={tileMenu.y}
          onClose={() => setTileMenu(null)}
          onStop={() => {
            connection.unwatch(tileMenu.slot);
            setTileMenu(null);
          }}
        />
      ) : null}

      {notice ? (
        <Toast
          message={notice.text}
          error={notice.error}
          {...(notice.action ? { action: notice.action } : {})}
          onDismiss={() => setNotice(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Onde a pessoa estava, para o relato de bug: tela, caminho e sala.
 *
 * Nunca o fragmento da URL — é nele que o crachá volta do login (`#identity=`).
 */
function feedbackWhere(inRoom: boolean): string {
  const room = new URLSearchParams(location.search).get("room");
  return `${inRoom ? "sala" : "lobby"} · ${location.pathname}${room ? `?room=${room}` : ""}`;
}

function Panel({ title, text }: { title: string; text: string }) {
  return (
    <div className="grid h-full place-items-center p-respiro text-center">
      <div>
        <p className="text-lg font-semibold text-texto">{title}</p>
        <p className="mt-1 text-suave">{text}</p>
      </div>
    </div>
  );
}

