import { defineConfig } from '@playwright/test';

/**
 * E2E contra a porta de entrada (:3000), como o resto da suíte: uma tela que
 * funciona no :3100 e quebra pelo :3000 é o tipo de falha que só o roteamento
 * revela. Mídia sintética — câmera falsa do Chromium e captura de tela
 * desenhada num canvas — para o pipeline real (WebCodecs → relay → canvas)
 * rodar sem ninguém na frente da máquina.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
    permissions: ['camera', 'microphone'],
  },
  webServer: [
    // O Discord falso: o relay manda os relatos de feedback para cá, nunca para o Discord de verdade.
    {
      command: 'node e2e/discord-mock.mjs',
      url: 'http://127.0.0.1:4999/__health',
      reuseExistingServer: true,
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:3000/api/health',
      reuseExistingServer: true,
      timeout: 120_000,
      // O `.env` do projeto tem credenciais e a origem pública reais; o teste não
      // pode usá-las (o link de captura abriria o site de produção, e o bot
      // postaria no canal de verdade). Variável já definida vence o `.env`.
      env: {
        PUBLIC_ORIGIN: 'http://localhost:3000',
        // Fixo para os testes assinarem crachás (ver `assinar` em e2e/ws.ts).
        SESSION_SECRET: 'segredo-so-de-teste-e2e',
        DISCORD_CLIENT_ID: '',
        DISCORD_CLIENT_SECRET: '',
        DISCORD_GUILD_IDS: '',
        DISCORD_API_BASE: 'http://127.0.0.1:4999',
        DISCORD_BOT_TOKEN: 'token-de-teste',
        FEEDBACK_CHANNEL_ID: '1561141729648840754',
        FEEDBACK_GUILD_ID: '576022672983457802',
        FEEDBACK_RATE_GLOBAL: '100000',
        // Os testes fazem centenas de pedidos do mesmo endereço.
        ABUSE_LIMITS: 'off',
      },
    },
  ],
});
