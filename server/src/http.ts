/**
 * O mínimo de HTTP que este servidor precisa, sem framework.
 *
 * Não há Express aqui porque não há o que ele resolveria: este processo não
 * serve arquivo nenhum — quem faz isso é o `app/` — e sobraram rotas JSON de
 * caminho fixo e dois redirects. Sem padrão de caminho para casar, o
 * roteamento é uma consulta a um objeto.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

// Teto do corpo. O maior pedido que chega são dois tokens assinados e um nome:
// alguns KB. Sem teto, um POST de gigabytes vira memória do mesmo processo que
// faz o relay de vídeo — e o relay morre junto com ele.
const MAX_BODY = 64 * 1024;

export type Body = Record<string, unknown>;

/** O corpo passou do teto; ver `readJson` e `createRouter`. */
const TOO_LARGE = Symbol('too-large');

export interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  body: Body;
  query: URLSearchParams;
}

export type Handler = (ctx: Context) => void | Promise<void>;

export function json(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // Tudo que sai daqui é token, identidade ou lista de sala viva. Nada disso
    // sobrevive a um cache intermediário sem virar bug.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

export const fail = (
  res: ServerResponse,
  status: number,
  message: string,
  extra: Record<string, unknown> = {}
): void => json(res, status, { error: message, ...extra });

export function redirect(res: ServerResponse, to: string): void {
  // no-referrer: o destino pode carregar crachá no fragmento ou token na query.
  res.writeHead(302, { Location: to, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end();
}

/**
 * Lê o corpo como JSON.
 *
 * @returns o objeto do corpo, `{}` se ele veio vazio, ou `null` se passou do
 * teto ou não é JSON — quem chama devolve 400 nos dois casos, porque a
 * diferença não muda nada para quem está do outro lado.
 */
function readJson(req: IncomingMessage): Promise<Body | null | typeof TOO_LARGE> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    let total = 0;
    let over = false;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (over) return; // já respondemos 413; só descarta o resto até a conexão fechar
      // Não destruir aqui: derrubar a conexão sem resposta deixava quem
      // enviou (e o proxy na frente) sem nada para devolver. Quem chama
      // responde 413 e fecha depois de enviar a resposta.
      if (total > MAX_BODY) {
        over = true;
        parts.length = 0;
        resolve(TOO_LARGE);
        return;
      }
      parts.push(chunk);
    });

    req.on('end', () => {
      if (over) return;
      if (parts.length === 0) return resolve({});
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
        // Array e string também são JSON válido, e nenhuma rota daqui os
        // espera: tratá-los como corpo faria `body.identity` virar undefined
        // silenciosamente, e o erro sairia como "identidade inválida".
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Body)
          : null);
      } catch {
        resolve(null);
      }
    });

    req.on('error', () => resolve(null));
  });
}

/**
 * Monta o despachante a partir de uma tabela `"MÉTODO /caminho": handler`.
 *
 * O try/catch aqui é o que o Express obrigava a repetir dentro de cada rota:
 * uma exceção não tratada num handler async derrubava o processo inteiro — e
 * derrubar o processo significa derrubar toda transmissão em curso.
 */
export function createRouter(routes: Record<string, Handler>, raw: Record<string, Handler> = {}) {
  return async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // O proxy do Discord entrega o caminho com /.proxy/ na frente. Ele já
    // costuma removê-lo no HTTP, mas remover aqui também não custa nada e
    // apaga uma classe inteira de bug que só aparece dentro do Discord: rota
    // que responde no navegador e devolve 404 na atividade.
    const url = new URL(req.url ?? '/', 'http://internal');
    const path = url.pathname.replace(/^\/\.proxy/, '') || '/';

    const key = `${req.method ?? 'GET'} ${path}`;

    // Rotas "cruas" leem o corpo por conta própria: o teto de 64 KB do leitor de
    // JSON abaixo existe para tokens e nomes, e recusaria qualquer upload. Quem
    // as declara assume impor o próprio teto de tamanho.
    const rawHandler = raw[key];
    if (rawHandler) {
      try {
        await rawHandler({ req, res, body: {}, query: url.searchParams });
      } catch (err) {
        console.error(`[http] ${key}:`, err);
        if (!res.headersSent) fail(res, 500, 'erro interno');
      }
      return;
    }

    const handler = routes[key];
    if (!handler) return fail(res, 404, 'rota inexistente');

    let body: Body = {};
    if (req.method === 'POST') {
      const parsed = await readJson(req);
      if (parsed === TOO_LARGE) {
        // Responde e só então fecha: o cliente recebe o 413 em vez de um reset.
        res.setHeader('Connection', 'close');
        res.once('finish', () => req.destroy());
        return fail(res, 413, 'corpo grande demais');
      }
      if (parsed === null) return fail(res, 400, 'corpo invalido');
      body = parsed;
    }

    try {
      await handler({ req, res, body, query: url.searchParams });
    } catch (err) {
      console.error(`[http] ${req.method ?? '?'} ${path}:`, err);
      if (!res.headersSent) fail(res, 500, 'erro interno');
    }
  };
}
