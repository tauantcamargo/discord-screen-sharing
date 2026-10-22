/**
 * Freios de abuso, em memória.
 *
 * Janela fixa por chave. Não é perfeito — rajadas na virada da janela passam —,
 * mas é barato, não tem dependência e basta para impedir que um laço de
 * requisições vire CPU ou RAM do mesmo processo que faz o relay de vídeo.
 */
import type { IncomingMessage } from 'node:http';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Só para a suíte de testes, que dispara centenas de pedidos do mesmo endereço.
 * Nunca ligue isto em produção.
 */
export const LIMITS_OFF = process.env.ABUSE_LIMITS === 'off';

/**
 * Conta um uso de `key`.
 *
 * @returns null se ainda cabe, ou os segundos até liberar.
 */
export function hit(key: string, max: number, windowMs: number): number | null {
  if (LIMITS_OFF) return null;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  if (b.count > max) return Math.max(1, Math.ceil((b.resetAt - now) / 1000));
  return null;
}

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60_000);
sweeper.unref();

/**
 * Endereço de quem fez o pedido.
 *
 * Em produção há sempre um proxy na frente (Traefik no Coolify, Caddy, ou a
 * porta de entrada do scripts/proxy.mjs), que sobrescreve o X-Forwarded-For de
 * quem chega de fora. Atrás dele o endereço do socket seria sempre o do proxy.
 * `CF-Connecting-IP` tem prioridade quando há Cloudflare na frente.
 */
export function clientIp(req: IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf.trim();
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  return xff || req.socket.remoteAddress || '?';
}
