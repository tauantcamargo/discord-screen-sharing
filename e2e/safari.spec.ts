import { test, expect, createRoom, joinRoom, shareScreen, videoCount, invite, isPlaying, comSom, type User } from './fixtures';

/**
 * Transmitir de um navegador que, como o Safari, não expõe
 * `MediaStreamTrackProcessor` na janela.
 *
 * O Chromium não transfere faixas para workers (o Safari 18+ sim), então o
 * worker real do Safari não roda aqui. O teste troca o `Worker` por um falso
 * que fala o mesmo protocolo de mensagens usando a API guardada da janela:
 * isso exercita o lado da página (`pumpViaWorker`) de ponta a ponta. O som sem
 * `MediaStreamTrackProcessor` vai por AudioWorklet, e esse roda de verdade.
 * Sem `Worker`, sobra o caminho via <video>.
 */

/** O <video> escondido que só o caminho de reserva cria (ver `pumpViaVideo`). */
const videoDeReserva = (user: User) =>
  user.page.evaluate(() => [...document.querySelectorAll('video')].filter((v) => v.style.left === '-9999px').length);

const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

async function comoSafari(user: User, { semWorker = false } = {}) {
  await user.context.addInitScript((noWorker) => {
    const w = window as unknown as Record<string, unknown>;
    const Processor = w.MediaStreamTrackProcessor as new (i: { track: MediaStreamTrack }) => {
      readable: ReadableStream<VideoFrame>;
    };
    delete w.MediaStreamTrackProcessor;
    if (noWorker) {
      delete w.Worker;
      return;
    }
    // Worker falso com o protocolo do FRAME_WORKER: start → ready/frame…, stop.
    w.Worker = class {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
      postMessage(data: { type: string; track?: MediaStreamTrack }) {
        if (data.type === 'stop') {
          void this.reader?.cancel();
          return;
        }
        const track = data.track!;
        this.reader = new Processor({ track }).readable.getReader();
        const emit = (d: unknown) => setTimeout(() => this.onmessage?.({ data: d }), 0);
        emit({ type: 'ready' });
        void (async () => {
          for (;;) {
            const r = await this.reader!.read().catch(() => ({ done: true, value: undefined }));
            if (r.done || !r.value) break;
            emit({ type: 'frame', frame: r.value });
          }
          track.stop();
        })();
      }
      terminate() {
        void this.reader?.cancel();
      }
    };
  }, semWorker);
}

async function abrirDetalhes(user: User) {
  await user.page.getByRole('button', { name: 'Mais opções' }).click();
  await user.page.getByRole('menuitem', { name: /Detalhes da conexão/ }).click();
  return user.page.getByRole('heading', { name: 'Detalhes' }).locator('xpath=../..');
}

test.describe('transmitir sem MediaStreamTrackProcessor na janela (Safari)', () => {
  test('quadros pelo worker e som pelo AudioWorklet chegam a quem assiste', async ({ spawn }) => {
    const ana = await spawn('Ana');
    const bia = await spawn('Bia');
    await comoSafari(ana);
    await comSom(ana);
    const sala = unique('safari');
    await createRoom(ana, sala);
    await joinRoom(bia, sala);

    await shareScreen(ana);
    await invite(bia).click();
    await expect.poll(() => videoCount(bia), { timeout: 15_000 }).toBe(1);
    await expect.poll(() => isPlaying(bia), { timeout: 10_000 }).toBe(true);
    // Os quadros vieram do worker, não do <video> de reserva.
    expect(await videoDeReserva(ana)).toBe(0);

    await expect(bia.page.getByRole('button', { name: 'Silenciar' })).toBeVisible({ timeout: 15_000 });
    const detalhes = await abrirDetalhes(bia);
    await expect(detalhes.getByText(/tocando/)).toBeVisible({ timeout: 10_000 });
  });

  test('sem worker, cai no caminho via <video> e a imagem continua chegando', async ({ spawn }) => {
    const ana = await spawn('Ana');
    const bia = await spawn('Bia');
    await comoSafari(ana, { semWorker: true });
    const sala = unique('safari-video');
    await createRoom(ana, sala);
    await joinRoom(bia, sala);

    await shareScreen(ana);
    await invite(bia).click();
    await expect.poll(() => videoCount(bia), { timeout: 15_000 }).toBe(1);
    await expect.poll(() => isPlaying(bia), { timeout: 10_000 }).toBe(true);
    expect(await videoDeReserva(ana)).toBe(1);
  });
});
