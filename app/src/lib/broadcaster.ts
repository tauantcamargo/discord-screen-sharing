/**
 * Pipeline de transmissão: captura → codifica → envia. Porte de
 * shared/broadcaster.js — tipagem por cima, lógica intacta.
 *
 * Sem WebRTC porque a Activity não tem (RN-PRO-2), e sem MediaRecorder porque o
 * container impõe piso de latência (RN-TRX-3). WebCodecs codifica quadro a
 * quadro e envia direto.
 */

// H264 costuma ter encoder por hardware; VP8 quase sempre cai em software, que
// a 1080p derruba o framerate. Por isso as duas variantes de H264 vêm antes.
// avcC (com `description`) primeiro: é o formato que todo decoder aceita —
// inclusive o do Safari, que não decodifica H264 em Annex B sem description.
// Como a config vai para quem assiste pelo servidor, o blob extra não custa
// nada. Annex B fica de reserva para encoder que não emita avcC (RN-TRX-12).
const CANDIDATES: Array<Partial<VideoEncoderConfig> & { codec: string }> = [
  { codec: 'avc1.42E01E' },
  { codec: 'avc1.42E01E', avc: { format: 'annexb' } },
  { codec: 'vp8' },
  { codec: 'vp09.00.10.08' },
];

/** Keyframe periódico: seguro barato para quem reconecta (RN-TRX-19). */
const KEYFRAME_EVERY_MS = 3000;

// O áudio anda pelo mesmo socket e pelo mesmo cabeçalho do vídeo: um canal só,
// um formato só, e o servidor continua repassando o buffer sem abrir nada.
const TYPE_KEYFRAME = 1;
const TYPE_DELTA = 2;
const TYPE_AUDIO = 3;

/** Opus estéreo a 96 kbps: transparente, e ruído perto do vídeo (RN-TRX-27). */
const AUDIO_BITRATE = 96_000;

/**
 * A única taxa que os dois lados do pipeline concordam de verdade (RN-AUD-14).
 * Testado isolado, direto na API do navegador: 44100 faz o `AudioDecoder` de
 * quem assiste falhar de forma assíncrona e muda; 48000 funciona, com o mesmo
 * config literal. O encoder é sempre configurado nesta taxa — quando a faixa
 * não chega nela, `createResampler()` (RN-AUD-15) resolve a diferença.
 */
const OPUS_SAMPLE_RATE = 48_000;

/** Teto de resolução (RN-TRX-14). A imagem é reduzida, nunca cortada. */
const MAX_W = 1920;
const MAX_H = 1080;

const even = (n: number) => Math.max(2, n - (n % 2));

/**
 * Reduz proporcionalmente até caber no teto. Nunca corta.
 *
 * O preset "Leve" baixa o teto para 720p (RN-TRX-36) pelo mesmo caminho — só
 * muda o número, não a regra.
 */
function fitWithin(w: number, h: number, maxH: number): { width: number; height: number } {
  const maxW = Math.round((MAX_W / MAX_H) * maxH);
  const scale = Math.min(1, maxW / w, maxH / h);
  return { width: even(Math.round(w * scale)), height: even(Math.round(h * scale)) };
}

/** Motivo pelo qual este navegador não consegue transmitir, ou null. */
export function supportError({ requireChromium = false } = {}): string | null {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return 'Este navegador não permite captura de tela. Navegador de celular não suporta captura — use um desktop.';
  }
  if (!('VideoEncoder' in window) || !('VideoFrame' in window) || !('EncodedVideoChunk' in window)) {
    return 'Este navegador não tem WebCodecs, necessário para transmitir. Use Chrome, Edge ou outro navegador Chromium no desktop.';
  }
  // Antes era exigência de produto transmitir só de Chromium (RN-TRX-4). Mas o
  // Discord abre o link de captura no navegador padrão — no Mac, quase sempre
  // o Safari —, e recusar ali empurrava todo mundo para instalar outro
  // navegador. Agora o Safari 18+ lê os quadros direto num worker (ver
  // `pumpViaWorker`), com a mesma qualidade do Chromium; só o que não tem nem
  // isso cai no caminho via <video>.
  void requireChromium; // mantido na assinatura para não quebrar quem chama
  return null;
}

/**
 * O Safari só expõe `MediaStreamTrackProcessor` dentro de workers — e a faixa
 * precisa ser transferível para chegar lá. É o que este worker faz: lê os
 * quadros da faixa e os devolve à página, transferidos (sem cópia).
 */
const FRAME_WORKER = `
let reader = null;
onmessage = async ({ data }) => {
  if (data.type === 'stop') {
    try { await reader?.cancel(); } catch {}
    try { data.track?.stop?.(); } catch {}
    return;
  }
  if (data.type !== 'start') return;
  if (typeof MediaStreamTrackProcessor === 'undefined') {
    try { data.track.stop(); } catch {}
    postMessage({ type: 'unsupported' });
    return;
  }
  const track = data.track;
  try {
    reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  } catch (err) {
    try { track.stop(); } catch {}
    postMessage({ type: 'unsupported', message: String(err) });
    return;
  }
  postMessage({ type: 'ready' });
  for (;;) {
    let r;
    try { r = await reader.read(); } catch { break; }
    if (r.done || !r.value) break;
    postMessage({ type: 'frame', frame: r.value }, [r.value]);
  }
  try { track.stop(); } catch {}
  postMessage({ type: 'done' });
};
`;

/**
 * Captura o som num AudioWorklet e entrega blocos Float32 planos à página.
 * É o caminho de áudio de quem não tem `MediaStreamTrackProcessor` na janela
 * (Safari): o AudioContext já roda a 48 kHz, então o navegador reamostra a
 * entrada sozinho e o Opus recebe a taxa que quer.
 */
const AUDIO_TAP_WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const copy = input.map((ch) => ch.slice(0));
      this.port.postMessage(copy, copy.map((c) => c.buffer));
    }
    return true;
  }
}
registerProcessor('sdt-tap', Tap);
`;

function blobUrl(code: string): string {
  return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
}

export interface BroadcastStatus {
  codec: string;
  width: number;
  height: number;
  direct: boolean;
}

export interface BroadcastStats {
  viewers: number;
  fps: number;
  mbps: number;
  seconds: number;
}

/** O que a prévia mostra antes de qualquer byte sair (RF-TRX-12). */
export interface Preview {
  track: MediaStreamTrack;
  width: number;
  height: number;
  hasSound: boolean;
  soundBlocked: boolean;
}

export interface Broadcaster {
  /** Capture e prepara, **sem enviar nada** (RN-TRX-38). */
  prepare: () => Promise<Preview>;
  /** A faixa capturada, para a prévia desenhar. null antes de preparar. */
  preparedTrack: () => MediaStreamTrack | null;
  /** Conecta e começa a enviar o que `prepare` deixou pronto. */
  goLive: () => Promise<MediaStream>;
  /** Preparar e ir ao ar de uma vez, para quem não quer prévia. */
  start: () => Promise<MediaStream>;
  stop: (reason?: string) => void;
  changeScreen: () => Promise<MediaStream>;
  swapSound: () => Promise<MediaStreamTrack>;
  /**
   * Troca o som por um dispositivo de entrada — mic físico, ou um cabo
   * virtual carregando o áudio de um app fora do navegador (RF-TRX-9).
   */
  useAudioInput: (deviceId: string) => Promise<MediaStreamTrack>;
  setQuality: (opts: { bitrate?: number; fps?: number; maxHeight?: number }) => void;
  getSettings: () => { bitrate: number; fps: number };
  hasSound: () => boolean;
  soundBlocked: () => boolean;
  isRunning: () => boolean;
}

export function createBroadcaster({
  wsUrl,
  bitrate,
  fps,
  maxHeight = MAX_H,
  source = 'screen',
  onStatus,
  onStats,
  onEnd,
  onError,
  onNotice,
}: {
  wsUrl: string;
  bitrate: number;
  fps: number;
  /** Teto de altura. 720 no preset Leve; 1080 no resto (RF-TRX-11). */
  maxHeight?: number;
  /**
   * Tela (`getDisplayMedia`) ou câmera (`getUserMedia`) (RF-CAM-1). Câmera é
   * só vídeo — a voz de quem transmite já vai pela call de verdade do
   * Discord, e captar o microfone aqui de novo seria duplicar ou entrar em
   * eco com o que a própria call já faz.
   */
  source?: 'screen' | 'camera';
  onStatus?: (info: BroadcastStatus) => void;
  onStats?: (stats: BroadcastStats) => void;
  onEnd?: (reason: string) => void;
  onError?: (msg: string) => void;
  onNotice?: (msg: string) => void;
}): Broadcaster {
  let ws: WebSocket | null = null;
  let stream: MediaStream | null = null;
  let encoder: VideoEncoder | null = null;
  let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  let audioEncoder: AudioEncoder | null = null;
  /** Lê o que vai para o encoder — a faixa original, ou a saída do reamostrador. */
  let audioReader: ReadableStreamDefaultReader<AudioData> | null = null;
  /** Só existem quando a faixa não chegou nativamente a 48 kHz (RN-AUD-15). */
  let audioRawReader: ReadableStreamDefaultReader<AudioData> | null = null;
  let audioResampler: ReturnType<typeof createResampler> | null = null;
  // Pediram som, mas a superfície escolhida traria o Discord junto. Guardado
  // para a interface poder oferecer a saída em vez de só avisar e esquecer.
  let soundBlocked = false;
  let video: HTMLVideoElement | null = null;
  /** Worker que lê os quadros no Safari (ver `pumpViaWorker`). */
  let frameWorker: Worker | null = null;
  /** Como os quadros estão chegando — vai para o diagnóstico da página. */
  let directCapture = 'MediaStreamTrackProcessor' in window;
  /** Captura de som via AudioWorklet (Safari); ver `pumpAudioViaWorklet`. */
  let audioTap: { close: () => void } | null = null;
  let config: VideoEncoderConfig | null = null;
  let stage: HTMLCanvasElement | null = null;
  let stageCtx: CanvasRenderingContext2D | null = null;

  let running = false;
  let mySlot = 0;
  let wantKeyframe = true;
  let lastKeyframeAt = 0;
  let srcW = 0;
  let srcH = 0;
  let startedAt = 0;
  let bytes = 0;
  let frames = 0;
  let viewers = 0;
  let statsTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * As duas preferências de fonte de áudio do `getDisplayMedia()` (RN-TRX-25a).
   *
   * `systemAudio` e `windowAudio` são opções de **topo**, irmãs de `video` e
   * `audio` — não entram nas `MediaTrackConstraints`. Foi assim, aninhado
   * dentro delas, que o código viveu por um tempo, e o navegador
   * silenciosamente ignora o que não reconhece: parecia funcionar (não dava
   * erro) e não fazia nada.
   *
   * `windowAudio: 'window'` é o que muda o jogo: manda o navegador oferecer o
   * **som daquela janela**, isolado, em vez do som do sistema inteiro — sem
   * ele, o seletor volta para a mistura de tudo. Existe desde o Chrome 141
   * (meados de 2025); em navegador mais velho, a opção é ignorada e o
   * comportamento antigo continua (sem quebrar nada).
   */
  function displayAudioOptions(): { systemAudio: 'exclude'; windowAudio: 'window' } {
    return { systemAudio: 'exclude', windowAudio: 'window' };
  }

  /**
   * Restrições da captura de som (RN-TRX-25).
   *
   * Os tratamentos de voz ficam desligados: existem para microfone e, em som de
   * aplicativo, cortam justamente o que se queria ouvir. `restrictOwnAudio` tira
   * da captura o que esta própria página está tocando — sem ele, quem transmite
   * enquanto assiste devolve o som da outra tela para a sala, em laço.
   */
  function audioConstraints(): MediaTrackConstraints {
    const c: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      // 48 kHz é o único que os dois lados do pipeline concordam de verdade
      // (RN-AUD-14): Opus só decodifica de forma confiável em 8/12/16/24/48
      // kHz, e é o `AudioDecoder` de quem assiste que rejeita o resto — sem
      // erro síncrono, sem `isConfigSupported()` acusar nada, só o `error`
      // calado depois. Sem pedir aqui, a faixa vem na taxa nativa do
      // dispositivo — 44100 é a mais comum em hardware de verdade — e o som
      // nunca chegava a tocar.
      //
      // `ideal`, e só `ideal`: `getDisplayMedia()` **rejeita `exact`/`min`/
      // `max` na hora**, com `TypeError: exact constraints are not
      // supported` — testado direto num navegador de verdade, quebrando a
      // transmissão inteira antes de o seletor sequer abrir. `ideal` não é
      // garantia (o dispositivo pode devolver 44100 mesmo assim, e aí volta o
      // buraco silencioso de antes) — mas é o único que este método aceita.
      sampleRate: { ideal: OPUS_SAMPLE_RATE },
    };
    if (navigator.mediaDevices.getSupportedConstraints().restrictOwnAudio) {
      c.restrictOwnAudio = true;
    }
    return c;
  }

  /**
   * Devolve a faixa de som, ou null quando ela traria a call de volta em eco
   * (RN-TRX-24).
   *
   * Tela inteira continua sem som — não existe processo nenhum para isolar
   * quando o que se compartilha é o desktop inteiro, então a mistura é sempre
   * o sistema junto com a saída do Discord.
   *
   * Janela de app **passou a valer** (RN-TRX-24a): com `windowAudio: 'window'`
   * pedido em `displayAudioOptions()`, o Chrome (141+) oferece o som só
   * daquela janela, não a mistura do sistema — é a mesma API que o Meet e o
   * Discord Web usam. Continua sendo um **pedido**, não garantia ("MAY ignore
   * this hint", no texto do padrão): o código confia no que o navegador
   * devolve, exatamente como qualquer outro site confia — não existe, em
   * nenhum lugar da spec, um jeito de o JavaScript conferir depois se o que
   * chegou era mesmo isolado. Navegador ou sistema sem suporte simplesmente
   * não entrega faixa de áudio nenhuma para janela, e cai no `!audioTrack`
   * ali embaixo — sem som, sem risco de eco.
   */
  function prepareSound(videoTrack: MediaStreamTrack, captured: MediaStream): MediaStreamTrack | null {
    const audioTrack = captured.getAudioTracks()[0];
    if (!audioTrack) return null;

    if (videoTrack.getSettings().displaySurface !== 'monitor') return audioTrack;

    audioTrack.stop();
    captured.removeTrack(audioTrack);
    soundBlocked = true;
    onNotice?.(
      'Tela inteira carrega o som do sistema junto — inclusive o do Discord —, e a call se ' +
        'ouviria em eco. Transmitindo sem som — compartilhe a janela do app (em vez da tela ' +
        'inteira) ou use "Som de uma aba" para escolher de onde vem o áudio.'
    );
    return null;
  }

  /**
   * Reamostra áudio para `targetRate`, na marra, com o único jeito que a web
   * oferece: tocar o `AudioBuffer` de origem — no formato que ele já é — num
   * `AudioContext` rodando na taxa alvo. A diferença de clock entre os dois é
   * o que faz a reamostragem acontecer; é assim que qualquer player de áudio
   * do navegador já reamostra por baixo dos panos (RN-AUD-15).
   *
   * Existe porque `ideal` em `audioConstraints()` **não é garantia**
   * (RN-AUD-14a): testado em produção, o pedido de 48 kHz na captura às vezes
   * não é honrado, e a faixa chega na taxa nativa do dispositivo mesmo assim
   * — 44100 é a mais comum em hardware de verdade, e é isso que o
   * `AudioDecoder` de quem assiste rejeita, calado. `exact` resolveria de
   * vez, mas `getDisplayMedia()` **recusa a chamada inteira** com `exact`
   * (`TypeError: exact constraints are not supported` — testado direto).
   * Sem alternativa na origem, a reamostragem tem que acontecer aqui.
   */
  function createResampler(
    targetRate: number,
    channels: number
  ): { track: MediaStreamTrack; push: (frame: AudioData) => void; close: () => void } {
    const ctx = new AudioContext({ sampleRate: targetRate });
    const dest = ctx.createMediaStreamDestination();
    // Mesmo colchão de audio.ts (RN-AUD-2): toca um pouco atrás do presente
    // para absorver a variação de quando cada quadro chega.
    const CUSHION = 0.05;
    let next = 0;

    function push(frame: AudioData): void {
      const buf = ctx.createBuffer(channels, frame.numberOfFrames, frame.sampleRate);
      for (let c = 0; c < channels; c++) {
        const plane = new Float32Array(frame.numberOfFrames);
        frame.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        buf.copyToChannel(plane, c);
      }

      const now = ctx.currentTime;
      if (next < now + 0.005) next = now + CUSHION;

      const source = ctx.createBufferSource();
      source.buffer = buf;
      source.connect(dest);
      source.start(next);
      next += buf.duration;
    }

    return {
      track: dest.stream.getAudioTracks()[0]!,
      push,
      close: () => void ctx.close().catch(() => {}),
    };
  }

  function onAudioEncoded(chunk: EncodedAudioChunk): void {
    if (ws?.readyState !== WebSocket.OPEN) return;

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    ws.send(packFrame(TYPE_AUDIO, chunk.timestamp, data));
    bytes += 18 + data.byteLength;
  }

  /**
   * Capture, codifica e envia o som.
   *
   * O AudioEncoder recebe os blocos no tamanho que o sistema entregar e devolve
   * pacotes Opus de 20 ms. Cada pacote se decodifica sozinho, então não existe
   * aqui o equivalente ao keyframe (RN-AUD-1).
   */
  async function pumpAudio(track: MediaStreamTrack): Promise<void> {
    if (!('AudioEncoder' in window)) return;
    if (!('MediaStreamTrackProcessor' in window)) return pumpAudioViaWorklet(track);

    const s = track.getSettings();
    // A taxa que a faixa relata — e não necessariamente a que se pediu.
    // `audioConstraints()` pede 48 kHz com `ideal` (RN-AUD-14): `exact`
    // resolveria de vez, mas `getDisplayMedia()` **recusa a chamada inteira**
    // com `exact` (`TypeError: exact constraints are not supported` —
    // testado direto), e `ideal` é só pedido — testado em produção, às vezes
    // não é honrado, e a faixa chega na nativa do dispositivo mesmo assim
    // (44100 é a mais comum em hardware de verdade). É o que o
    // `AudioDecoder.configure()` de quem assiste rejeita, **de forma
    // assíncrona e muda**: nem lança exceção, nem `isConfigSupported()`
    // acusa nada. Som nunca tocava em nenhuma transmissão cujo dispositivo
    // não desse 48 kHz de bandeja.
    //
    // Por isso o encoder é sempre configurado a 48 kHz, e reamostra-se aqui
    // (RN-AUD-15) sempre que a faixa não chegou nesse valor — a única forma
    // de garantir sem depender do navegador, do sistema ou do hardware.
    const nativeRate = s.sampleRate ?? OPUS_SAMPLE_RATE;
    const sampleRate = OPUS_SAMPLE_RATE;
    const numberOfChannels = Math.min(2, s.channelCount ?? 2);

    try {
      audioEncoder = new AudioEncoder({
        output: onAudioEncoded,
        // Som é acessório: se o encoder cair, a tela continua no ar (RN-TRX-29).
        error: (err) => console.warn('[audio encoder]', err.message),
      });
      audioEncoder.configure({ codec: 'opus', sampleRate, numberOfChannels, bitrate: AUDIO_BITRATE });
    } catch (err) {
      console.warn('[audio encoder]', err instanceof Error ? err.message : err);
      audioEncoder = null;
      return;
    }

    // O mesmo caminho do vídeo: quem chega depois recebe isto ao pedir a tela.
    ws?.send(
      JSON.stringify({
        type: 'audio-config',
        config: { codec: 'opus', sampleRate, numberOfChannels },
      })
    );

    let encodeSource = track;

    if (nativeRate !== sampleRate) {
      // A faixa original alimenta o reamostrador; o encoder lê a saída dele.
      // Dois laços porque são dois relógios diferentes — ler um quadro
      // reamostrado não é ler um quadro original, e tentar fundir os dois
      // num laço só significava travar um esperando o outro.
      const resampler = createResampler(sampleRate, numberOfChannels);
      audioResampler = resampler;
      encodeSource = resampler.track;

      audioRawReader = new MediaStreamTrackProcessor<AudioData>({ track }).readable.getReader();
      void (async () => {
        while (running) {
          let raw: AudioData;
          try {
            const { done, value } = await audioRawReader!.read();
            if (done || !value) break;
            raw = value;
          } catch {
            break;
          }
          resampler.push(raw);
          raw.close();
        }
      })();
    }

    audioReader = new MediaStreamTrackProcessor<AudioData>({ track: encodeSource }).readable.getReader();
    while (running) {
      let data: AudioData;
      try {
        const { done, value } = await audioReader.read();
        if (done || !value) break;
        data = value;
      } catch {
        break;
      }

      if (audioEncoder?.state === 'configured') {
        try {
          audioEncoder.encode(data);
        } catch (err) {
          console.warn('[audio encode]', err instanceof Error ? err.message : err);
        }
      }
      data.close();
    }
  }

  /**
   * Som sem `MediaStreamTrackProcessor` (Safari 26+, que já tem AudioEncoder).
   *
   * Um AudioWorklet copia os blocos de 128 amostras; aqui eles são juntados em
   * pacotes de 20 ms e viram `AudioData` para o mesmo encoder Opus do caminho
   * do Chromium. O AudioContext a 48 kHz faz a reamostragem (RN-AUD-15).
   */
  async function pumpAudioViaWorklet(track: MediaStreamTrack): Promise<void> {
    if (typeof AudioWorkletNode === 'undefined') return;

    const sampleRate = OPUS_SAMPLE_RATE;
    const numberOfChannels = Math.min(2, track.getSettings().channelCount ?? 2);
    const ctx = new AudioContext({ sampleRate });
    const url = blobUrl(AUDIO_TAP_WORKLET);
    try {
      await ctx.audioWorklet.addModule(url);
    } catch (err) {
      console.warn('[audio tap]', err instanceof Error ? err.message : err);
      void ctx.close();
      return;
    } finally {
      URL.revokeObjectURL(url);
    }

    try {
      audioEncoder = new AudioEncoder({
        output: onAudioEncoded,
        error: (err) => console.warn('[audio encoder]', err.message),
      });
      audioEncoder.configure({ codec: 'opus', sampleRate, numberOfChannels, bitrate: AUDIO_BITRATE });
    } catch (err) {
      console.warn('[audio encoder]', err instanceof Error ? err.message : err);
      audioEncoder = null;
      void ctx.close();
      return;
    }

    ws?.send(JSON.stringify({ type: 'audio-config', config: { codec: 'opus', sampleRate, numberOfChannels } }));

    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const node = new AudioWorkletNode(ctx, 'sdt-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: numberOfChannels,
      channelCountMode: 'explicit',
    });
    // O worklet só roda se o grafo for puxado até a saída; ganho zero para
    // não tocar o som de volta em quem transmite.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node).connect(mute).connect(ctx.destination);
    void ctx.resume().catch(() => {});

    const PACKET = sampleRate / 50; // 20 ms
    const pending: Float32Array[] = Array.from({ length: numberOfChannels }, () => new Float32Array(PACKET));
    let filled = 0;
    let sent = 0;

    node.port.onmessage = ({ data }: MessageEvent<Float32Array[]>) => {
      if (!running || audioEncoder?.state !== 'configured') return;
      const frames = data[0]?.length ?? 0;
      let offset = 0;
      while (offset < frames) {
        const take = Math.min(PACKET - filled, frames - offset);
        for (let c = 0; c < numberOfChannels; c++) {
          const ch = data[c] ?? data[0]!;
          pending[c]!.set(ch.subarray(offset, offset + take), filled);
        }
        filled += take;
        offset += take;
        if (filled === PACKET) {
          const planar = new Float32Array(PACKET * numberOfChannels);
          for (let c = 0; c < numberOfChannels; c++) planar.set(pending[c]!, c * PACKET);
          const audio = new AudioData({
            format: 'f32-planar',
            sampleRate,
            numberOfFrames: PACKET,
            numberOfChannels,
            timestamp: Math.round((sent / sampleRate) * 1e6),
            data: planar,
          });
          sent += PACKET;
          filled = 0;
          try {
            audioEncoder.encode(audio);
          } catch (err) {
            console.warn('[audio encode]', err instanceof Error ? err.message : err);
          }
          audio.close();
        }
      }
    };

    audioTap = {
      close: () => {
        node.port.onmessage = null;
        try {
          source.disconnect();
          node.disconnect();
        } catch {
          // já desconectado
        }
        void ctx.close().catch(() => {});
      },
    };
  }

  async function pickConfig(width: number, height: number): Promise<VideoEncoderConfig | null> {
    // Duas passadas (RN-TRX-13): navegadores que não conhecem `latencyMode`
    // recusam a configuração inteira por causa dela. Mais latência é melhor que
    // nada.
    for (const realtime of [true, false]) {
      for (const candidate of CANDIDATES) {
        const cfg: VideoEncoderConfig = { ...candidate, width, height, bitrate, framerate: fps };
        if (realtime) cfg.latencyMode = 'realtime';
        try {
          const { supported } = await VideoEncoder.isConfigSupported(cfg);
          if (supported) return cfg;
        } catch {
          // candidato inválido neste navegador; tenta o próximo
        }
      }
    }
    return null;
  }

  /**
   * [1B slot][1B tipo][8B timestamp][8B relógio de envio][payload]
   *
   * O slot vem carimbado na origem para o servidor repassar o buffer intacto
   * (RN-PRO-17), e o relógio de envio é o que permite medir o atraso do outro
   * lado. Áudio e vídeo compartilham o formato (RN-PRO-18).
   */
  function packFrame(kind: number, timestamp: number, data: Uint8Array): ArrayBuffer {
    const buf = new ArrayBuffer(18 + data.byteLength);
    const view = new DataView(buf);
    view.setUint8(0, mySlot);
    view.setUint8(1, kind);
    view.setFloat64(2, timestamp);
    view.setFloat64(10, Date.now());
    new Uint8Array(buf, 18).set(data);
    return buf;
  }

  function serializeConfig(dc: VideoDecoderConfig): Record<string, unknown> {
    const out: Record<string, unknown> = {
      codec: dc.codec,
      codedWidth: dc.codedWidth,
      codedHeight: dc.codedHeight,
    };
    if (dc.description) {
      const b = new Uint8Array(
        dc.description instanceof ArrayBuffer ? dc.description : (dc.description as ArrayBufferView).buffer
      );
      let bin = '';
      for (const x of b) bin += String.fromCharCode(x);
      out.description = btoa(bin);
    }
    return out;
  }

  function onEncoded(chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata): void {
    if (ws?.readyState !== WebSocket.OPEN) return;

    // O decoderConfig chega no primeiro chunk e sempre que a config muda.
    if (metadata?.decoderConfig) {
      ws.send(JSON.stringify({ type: 'config', config: serializeConfig(metadata.decoderConfig) }));
    }

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);

    const buf = packFrame(chunk.type === 'key' ? TYPE_KEYFRAME : TYPE_DELTA, chunk.timestamp, data);
    ws.send(buf);
    bytes += buf.byteLength;
  }

  /**
   * Mantém o encoder casado com o tamanho real da fonte (RN-TRX-18).
   *
   * displayWidth/Height e não codedWidth/Height: o codificado inclui padding de
   * alinhamento do codec, e configurar o encoder por ele recorta as bordas.
   */
  function syncSize(frame: VideoFrame): void {
    const sw = frame.displayWidth;
    const sh = frame.displayHeight;
    if (!sw || !sh || (sw === srcW && sh === srcH) || !config || !encoder) return;

    srcW = sw;
    srcH = sh;
    const target = fitWithin(sw, sh, maxHeight);

    if (target.width !== config.width || target.height !== config.height) {
      config = { ...config, ...target };
      encoder.configure(config);
      // Reconfigurar força keyframe: o decoder do outro lado foi recriado e
      // volta a precisar de ponto de partida (RN-TRX-21).
      wantKeyframe = true;
      onStatus?.({
        codec: config.codec,
        width: target.width,
        height: target.height,
        direct: directCapture,
      });
    }

    // fitWithin preserva a proporção, então reduzir não corta nada.
    if (target.width === sw && target.height === sh) {
      stage = null;
      stageCtx = null;
    } else {
      stage = document.createElement('canvas');
      stage.width = target.width;
      stage.height = target.height;
      stageCtx = stage.getContext('2d', { alpha: false, desynchronized: true });
    }
  }

  function encodeFrame(frame: VideoFrame): boolean {
    if (!running || encoder?.state !== 'configured') {
      frame.close();
      return false;
    }
    // Backpressure: fila no encoder vira latência que nunca mais sai (RN-TRX-16).
    if (encoder.encodeQueueSize > 2) {
      frame.close();
      return true;
    }

    const timestamp = frame.timestamp;
    syncSize(frame);

    const now = Date.now();
    if (now - lastKeyframeAt > KEYFRAME_EVERY_MS) wantKeyframe = true;

    let out = frame;
    if (stage && stageCtx) {
      stageCtx.drawImage(frame, 0, 0, stage.width, stage.height);
      frame.close();
      out = new VideoFrame(stage, { timestamp });
    }

    try {
      encoder.encode(out, { keyFrame: wantKeyframe });
      if (wantKeyframe) {
        lastKeyframeAt = now;
        wantKeyframe = false;
      }
    } catch (err) {
      console.error('[encode]', err);
    }

    // frame.close() sempre depois de usar: VideoFrame segura memória de GPU, e
    // sem isso a aba trava em segundos (RN-TRX-17).
    out.close();
    frames++;
    return true;
  }

  /** Chromium: acesso direto aos quadros, sem cópia intermediária (RN-TRX-22). */
  async function pumpDirect(track: MediaStreamTrack): Promise<void> {
    reader = new MediaStreamTrackProcessor<VideoFrame>({ track }).readable.getReader();
    while (running) {
      let frame: VideoFrame;
      try {
        const { done, value } = await reader.read();
        if (done || !value) break;
        frame = value;
      } catch {
        break;
      }
      if (!encodeFrame(frame)) break;
    }
  }

  /**
   * Demais navegadores: extrai os quadros de um `<video>` alimentado pela stream.
   *
   * O elemento fica no DOM mas fora do fluxo (RN-TRX-23): alguns navegadores não
   * decodificam um elemento solto, e `display: none` chega a pausar a
   * reprodução.
   */
  function pumpViaVideo(): void {
    const el = document.createElement('video');
    video = el;
    el.muted = true;
    el.playsInline = true;
    el.srcObject = stream;
    Object.assign(el.style, {
      position: 'fixed',
      left: '-9999px',
      width: '2px',
      height: '2px',
      opacity: '0',
    });
    document.body.append(el);
    void el.play().catch(() => {});

    const t0 = performance.now();
    const rvfc = el.requestVideoFrameCallback?.bind(el);
    const minGap = 1000 / (fps + 2);
    let lastAt = 0;

    const schedule = () => {
      if (!running) return;
      if (rvfc) rvfc(tick);
      else requestAnimationFrame(tick);
    };

    const tick = () => {
      if (!running) return;
      // Alguns navegadores pausam ao trocar de aba; sem isso o laço morre em
      // silêncio e a transmissão congela sem erro nenhum.
      if (el.paused) void el.play().catch(() => {});
      if (el.readyState < 2 || !el.videoWidth) return schedule();

      const now = performance.now();
      // rAF segue o refresh da tela, que pode estar bem acima do fps alvo.
      if (!rvfc && now - lastAt < minGap) return schedule();
      lastAt = now;

      let frame: VideoFrame;
      try {
        frame = new VideoFrame(el, { timestamp: (now - t0) * 1000 });
      } catch {
        return schedule();
      }
      encodeFrame(frame);
      schedule();
    };

    schedule();
  }

  /**
   * Safari 18+: os quadros são lidos num worker e transferidos para cá.
   *
   * Vai uma cópia (`clone`) da faixa, e não a original: se o worker não
   * souber ler, a original continua aqui, intacta, para o caminho via <video>.
   */
  function pumpViaWorker(track: MediaStreamTrack): void {
    let worker: Worker;
    let clone: MediaStreamTrack;
    try {
      const url = blobUrl(FRAME_WORKER);
      worker = new Worker(url);
      URL.revokeObjectURL(url);
      clone = track.clone();
    } catch {
      pumpViaVideo();
      return;
    }

    let settled = false;
    const fallback = () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      if (frameWorker === worker) frameWorker = null;
      directCapture = false;
      if (running) pumpViaVideo();
    };

    worker.onmessage = ({ data }: MessageEvent) => {
      if (data.type === 'frame') {
        settled = true;
        const frame = data.frame as VideoFrame;
        if (frameWorker !== worker) {
          frame.close();
          return;
        }
        encodeFrame(frame);
      } else if (data.type === 'unsupported') {
        fallback();
      }
    };
    worker.onerror = fallback;

    try {
      worker.postMessage({ type: 'start', track: clone }, [clone as unknown as Transferable]);
    } catch {
      // DataCloneError: este navegador não transfere faixas para workers.
      clone.stop();
      fallback();
      return;
    }
    frameWorker = worker;
    directCapture = true;
    // Sem resposta em 3 s, desiste do worker e usa o <video>.
    setTimeout(() => {
      if (!settled) fallback();
    }, 3000);
  }

  function stopFramePump(): void {
    if (frameWorker) {
      frameWorker.postMessage({ type: 'stop' });
      const w = frameWorker;
      frameWorker = null;
      setTimeout(() => w.terminate(), 500);
    }
  }

  function pump(track: MediaStreamTrack): void {
    if ('MediaStreamTrackProcessor' in window) {
      directCapture = true;
      void pumpDirect(track);
    } else if (typeof Worker !== 'undefined' && 'VideoFrame' in window) {
      pumpViaWorker(track);
    } else {
      directCapture = false;
      pumpViaVideo();
    }
  }

  function cleanup(): void {
    stopFramePump();
    audioTap?.close();
    audioTap = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video?.remove();
    video = null;
    stage = null;
    stageCtx = null;
  }

  /**
   * Encerra tudo (RN-TRX-32): intervalo de estatísticas, leitores, ambos os
   * encoders, todas as tracks, o `<video>` auxiliar e o canvas de redimensão.
   * Depois manda `stop` e fecha o socket.
   */
  function stop(reason?: string): void {
    const wasRunning = running;
    running = false;

    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;

    void reader?.cancel().catch(() => {});
    reader = null;
    void audioReader?.cancel().catch(() => {});
    audioReader = null;
    void audioRawReader?.cancel().catch(() => {});
    audioRawReader = null;
    audioResampler?.close();
    audioResampler = null;
    audioTap?.close();
    audioTap = null;

    for (const e of [encoder, audioEncoder]) {
      if (e?.state === 'configured') {
        try {
          e.close();
        } catch {
          // já fechado
        }
      }
    }
    encoder = null;
    audioEncoder = null;

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
      ws.close();
    }
    ws = null;

    cleanup();
    if (wasRunning) onEnd?.(reason ?? '');
  }

  function connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      ws = socket;
      socket.binaryType = 'arraybuffer';

      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('Não foi possível falar com o servidor (timeout).'));
      }, 10_000);

      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      });

      socket.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') return;
        const msg = JSON.parse(e.data) as { type: string; slot?: number; viewers?: number; message?: string };

        if (msg.type === 'slot') mySlot = msg.slot ?? 0;
        else if (msg.type === 'state') viewers = msg.viewers ?? 0;
        // Alguém entrou na sala e precisa de um ponto de partida (RN-TRX-20).
        else if (msg.type === 'need-keyframe') wantKeyframe = true;
        else if (msg.type === 'stop-request') stop('Transmissão encerrada pela atividade.');
        else if (msg.type === 'error') {
          if (running) stop(msg.message);
          else {
            clearTimeout(timeout);
            reject(new Error(msg.message));
          }
        }
      });

      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Falha ao conectar no servidor.'));
      });

      socket.addEventListener('close', () => {
        clearTimeout(timeout);
        if (running) stop('Conexão com o servidor caiu.');
      });
    });
  }

  /** A faixa preparada, esperando a confirmação da prévia. */
  let preparedTrack: MediaStreamTrack | null = null;

  /**
   * Capture e escolhe o codec, **sem abrir socket nem encoder** (RN-TRX-38).
   *
   * É aqui que a prévia se apoia: a pessoa ainda não está no ar, então trocar
   * de tela ou resolver o som barrado não custa nada a ninguém (RN-TRX-37).
   */
  /**
   * Pede a tela com som; se o navegador recusar o pedido de som em si (o
   * Safari não captura áudio de tela, e versões antigas recusam a chamada
   * inteira), pede de novo só a imagem. Cancelar o seletor não é recusa:
   * esse erro sobe como veio.
   */
  async function captureDisplay(): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: fps, max: fps } },
        audio: audioConstraints(),
        ...displayAudioOptions(),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name !== 'TypeError' && name !== 'OverconstrainedError') throw err;
      return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: fps, max: fps } } });
    }
  }

  async function prepare(): Promise<Preview> {
    // Precisa vir do gesto do usuário; qualquer await antes disso o invalida
    // (RN-TRX-6).
    const captured =
      source === 'camera'
        ? await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', frameRate: { ideal: fps, max: fps } },
          })
        : // Sempre pedido (RN-TRX-24c): quem decide se aquela transmissão leva
          // som é o checkbox do seletor nativo do navegador, não este código.
          await captureDisplay();
    stream = captured;

    const track = captured.getVideoTracks()[0];
    if (!track) {
      cleanup();
      throw new Error(source === 'camera' ? 'A câmera não devolveu imagem.' : 'A captura veio sem imagem.');
    }

    // 'text' preserva nitidez de borda — o que uma tela de app/texto quer.
    // Câmera é o oposto: vídeo natural quer suavização, não borda dura, e o
    // hint padrão ('motion') já faz isso sozinho (RN-CAM-2).
    if (source === 'screen') track.contentHint = 'text';
    track.addEventListener('ended', () =>
      stop(source === 'camera' ? 'Você desligou a câmera.' : 'Você parou o compartilhamento pelo navegador.')
    );

    const s = track.getSettings();
    const target = fitWithin(s.width ?? 1280, s.height ?? 720, maxHeight);

    config = await pickConfig(target.width, target.height);
    if (!config) {
      cleanup();
      throw new Error('Nenhum codec de vídeo suportado por este navegador.');
    }

    // Câmera é só vídeo (RF-CAM-1): sem faixa de som para resolver aqui.
    const soundTrack = source === 'camera' ? null : prepareSound(track, captured);
    preparedTrack = track;

    return {
      track,
      width: target.width,
      height: target.height,
      hasSound: Boolean(soundTrack),
      soundBlocked,
    };
  }

  async function goLive(): Promise<MediaStream> {
    const track = preparedTrack;
    const captured = stream;
    if (!track || !captured || !config) throw new Error('Nada preparado para transmitir.');

    await connect();

    encoder = new VideoEncoder({
      output: onEncoded,
      error: (err) => stop(`Erro no encoder: ${err.message}`),
    });
    encoder.configure(config);

    ws?.send(JSON.stringify({ type: 'start', kind: source }));

    running = true;
    wantKeyframe = true;
    lastKeyframeAt = 0;
    srcW = 0;
    srcH = 0;
    startedAt = Date.now();

    onStatus?.({
      codec: config.codec,
      width: config.width,
      height: config.height,
      direct: directCapture,
    });

    statsTimer = setInterval(() => {
      onStats?.({
        viewers,
        fps: frames,
        mbps: (bytes * 8) / 1e6,
        seconds: Math.floor((Date.now() - startedAt) / 1000),
      });
      bytes = 0;
      frames = 0;
    }, 1000);

    pump(track);
    // Pedir áudio não garante receber (RN-TRX-26): em vários sistemas a caixa
    // "compartilhar o som" fica desmarcada e o navegador devolve a tela sem
    // faixa de som. A faixa já foi decidida em prepare().
    const audioTrack = captured.getAudioTracks()[0];
    if (audioTrack) void pumpAudio(audioTrack);

    return captured;
  }

  async function start(): Promise<MediaStream> {
    await prepare();
    return goLive();
  }

  /**
   * Troca só a fonte do som, sem tocar no vídeo (RF-TRX-6).
   *
   * É o que torna som e tela inteira compatíveis: o vídeo continua sendo a tela
   * escolhida e o som passa a vir de uma aba, que é isolada por construção.
   */
  async function swapSound(): Promise<MediaStreamTrack> {
    const choice = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: audioConstraints(),
      ...displayAudioOptions(),
    });

    const audioTrack = choice.getAudioTracks()[0];
    const surface = choice.getVideoTracks()[0]?.getSettings().displaySurface;

    // O vídeo desta escolha não interessa: viemos só pelo som.
    choice.getVideoTracks().forEach((t) => t.stop());

    if (!audioTrack) {
      choice.getTracks().forEach((t) => t.stop());
      throw new Error(
        'Essa escolha veio sem som. Escolha uma aba ou uma janela, e marque a opção de ' +
          'compartilhar o áudio.'
      );
    }

    // Igual a prepareSound() (RN-TRX-24a): só a tela inteira é sempre a
    // mistura do sistema. Aba e janela têm como vir isoladas.
    if (surface === 'monitor') {
      audioTrack.stop();
      throw new Error(
        'Tela inteira traria o Discord junto, e a call se ouviria em eco. Escolha uma aba ' +
          'ou uma janela.'
      );
    }

    // Encerra o laço anterior antes de abrir outro (RN-TRX-28), senão os dois
    // alimentam o mesmo encoder e a fila estoura.
    await audioReader?.cancel().catch(() => {});
    audioReader = null;
    await audioRawReader?.cancel().catch(() => {});
    audioRawReader = null;
    audioResampler?.close();
    audioResampler = null;
    audioTap?.close();
    audioTap = null;
    if (audioEncoder?.state === 'configured') {
      try {
        audioEncoder.close();
      } catch {
        // já fechado
      }
    }
    audioEncoder = null;

    soundBlocked = false;
    audioTrack.addEventListener('ended', () => onNotice?.('A aba do som foi fechada.'));
    void pumpAudio(audioTrack);
    return audioTrack;
  }

  /**
   * Troca o som por um dispositivo de entrada (RF-TRX-9).
   *
   * A saída real para quem compartilha um app **fora do navegador**: nenhuma
   * API web isola o áudio de um processo alheio (RN-TRX-24b) — nem
   * `windowAudio`, que só alcança o que o próprio navegador (ou outra janela
   * dele) está tocando. Um cabo de áudio virtual — VB-Cable no Windows,
   * BlackHole ou Loopback no Mac — resolve fora da web: o app de origem manda
   * o som para lá, e o cabo aparece no sistema como um microfone comum, que
   * `getUserMedia()` capta sem restrição nenhuma, isolado por construção — é
   * o mesmo dispositivo, então é só ele que chega.
   *
   * `deviceId` vem de `navigator.mediaDevices.enumerateDevices()`, filtrado a
   * `audioinput`. Os tratamentos de voz ficam desligados pelo mesmo motivo de
   * `audioConstraints()`: um cabo virtual não é uma voz para "limpar".
   */
  async function useAudioInput(deviceId: string): Promise<MediaStreamTrack> {
    const picked = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        // `exact` funciona aqui — `getUserMedia()` aceita, diferente de
        // `getDisplayMedia()` (ver `audioConstraints()`). Falhar alto na
        // hora, se o dispositivo não souber reamostrar, é melhor que
        // transmitir com som quebrado sem ninguém saber.
        sampleRate: { exact: OPUS_SAMPLE_RATE },
      },
    });

    const audioTrack = picked.getAudioTracks()[0];
    if (!audioTrack) {
      picked.getTracks().forEach((t) => t.stop());
      throw new Error('Não consegui captar esse dispositivo de áudio.');
    }

    // Mesma limpeza de swapSound() (RN-TRX-28): encerra o laço anterior antes
    // de abrir outro, senão os dois alimentam o mesmo encoder e a fila
    // estoura.
    await audioReader?.cancel().catch(() => {});
    audioReader = null;
    await audioRawReader?.cancel().catch(() => {});
    audioRawReader = null;
    audioResampler?.close();
    audioResampler = null;
    audioTap?.close();
    audioTap = null;
    if (audioEncoder?.state === 'configured') {
      try {
        audioEncoder.close();
      } catch {
        // já fechado
      }
    }
    audioEncoder = null;

    soundBlocked = false;
    audioTrack.addEventListener('ended', () => onNotice?.('O dispositivo de áudio foi desconectado.'));
    void pumpAudio(audioTrack);
    return audioTrack;
  }

  /**
   * Troca a tela compartilhada sem derrubar a transmissão (RF-TRX-8).
   *
   * A conexão, o encoder e o slot continuam os mesmos — quem assiste só vê a
   * imagem mudar, sem piscar nem reconectar.
   */
  async function changeScreen(): Promise<MediaStream> {
    const fresh = await captureDisplay();

    const previous = stream;
    const previousReader = reader;

    stream = fresh;
    const track = fresh.getVideoTracks()[0];
    if (!track) throw new Error('A captura veio sem imagem.');

    track.contentHint = 'text';
    track.addEventListener('ended', () => stop('Você parou o compartilhamento pelo navegador.'));

    reader = null;
    await previousReader?.cancel().catch(() => {});
    stopFramePump();
    previous?.getTracks().forEach((t) => t.stop());

    // Zera o tamanho conhecido: a tela nova quase certamente tem outro, e é o
    // syncSize que reconfigura o encoder.
    srcW = 0;
    srcH = 0;
    wantKeyframe = true;

    if (video) {
      video.srcObject = fresh;
      void video.play().catch(() => {});
    } else {
      pump(track);
    }

    // A tela nova traz a própria faixa de som; a antiga morreu com o stream.
    await audioReader?.cancel().catch(() => {});
    audioReader = null;
    await audioRawReader?.cancel().catch(() => {});
    audioRawReader = null;
    audioResampler?.close();
    audioResampler = null;
    audioTap?.close();
    audioTap = null;
    const newAudio = prepareSound(track, fresh);
    if (newAudio && audioEncoder) void pumpAudio(newAudio);

    return fresh;
  }

  /** Ajusta qualidade e taxa de quadros com a transmissão no ar (RF-TRX-7). */
  function setQuality({
    bitrate: nextBitrate,
    fps: nextFps,
    maxHeight: nextMax,
  }: { bitrate?: number; fps?: number; maxHeight?: number } = {}): void {
    if (nextBitrate) bitrate = nextBitrate;
    if (nextFps) fps = nextFps;
    if (nextMax) {
      maxHeight = nextMax;
      // Zera o tamanho conhecido para o syncSize refazer a conta com o teto novo.
      srcW = 0;
      srcH = 0;
    }
    if (encoder?.state !== 'configured' || !config) return;

    config = { ...config, bitrate, framerate: fps };
    encoder.configure(config);
    wantKeyframe = true;

    // Pedir a taxa nova à própria captura evita gastar CPU codificando quadros
    // que seriam descartados adiante.
    void stream
      ?.getVideoTracks()[0]
      ?.applyConstraints({ frameRate: { ideal: fps, max: fps } })
      .catch(() => {});
  }

  if (onError) {
    // O erro do pipeline chega por onEnd; onError fica para quem quiser separar
    // falha de encerramento normal.
  }

  return {
    prepare,
    preparedTrack: () => preparedTrack,
    goLive,
    start,
    stop,
    changeScreen,
    swapSound,
    useAudioInput,
    setQuality,
    getSettings: () => ({ bitrate, fps }),
    hasSound: () => Boolean(audioEncoder),
    soundBlocked: () => soundBlocked,
    isRunning: () => running,
  };
}
