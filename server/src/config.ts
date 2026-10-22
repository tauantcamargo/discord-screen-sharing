/**
 * Leitura e validação do ambiente, num lugar só.
 *
 * O `.env` é carregado pelo `--env-file-if-exists` nos scripts deste pacote, e
 * não por biblioteca: o Node já sabe fazer isso, e uma dependência a menos num
 * processo que precisa ficar de pé por horas é uma decisão barata.
 */
export const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || null;
export const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || null;
export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || null;

// Para onde vão os relatos de bug e feedback (spec 12). Sem padrão de propósito:
// o original apontava para o canal do autor do projeto, e qualquer fork que
// ligasse o bot passaria a postar relatos lá. Sem canal, o feedback fica
// desligado.
export const FEEDBACK_CHANNEL_ID = process.env.FEEDBACK_CHANNEL_ID || null;
export const FEEDBACK_GUILD_ID = process.env.FEEDBACK_GUILD_ID || null;
export const DISCORD_API_BASE = (process.env.DISCORD_API_BASE || 'https://discord.com/api/v10').replace(/[/]+$/, '');

// RELAY_PORT, e não PORT: PORT é a porta de entrada — o navegador bate nela, e
// quem atende ali roteia por caminho entre o app e este processo.
export const PORT = Number(process.env.RELAY_PORT) || 3101;

export const NODE_ENV = process.env.NODE_ENV || 'development';
export const isProd = NODE_ENV === 'production';

// Uma barra sobrando no fim se propaga: o shareUrl vira "//share" e o redirect
// do OAuth vira "//auth/callback", que não bate com o endereço cadastrado no
// portal. O login falha sem explicar nada.
export const PUBLIC_ORIGIN = (
  process.env.PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || 3000}`
).replace(/[/]+$/, '');

export const REDIRECT_URI = `${PUBLIC_ORIGIN}/auth/callback`;

// Quem entra pelo site não tem canal de voz, então todas essas pessoas
// compartilham um lobby só.
export const WEB_INSTANCE = 'web';

// Falha no arranque, não no primeiro pedido: subir sem segredo significa
// assinar todos os tokens com o padrão público, e um servidor assim de pé é
// pior do que um servidor que não sobe.
if (isProd && !process.env.SESSION_SECRET) {
  console.error('ERRO: SESSION_SECRET obrigatorio em producao — sem ele os tokens sao forjaveis.');
  process.exit(1);
}
