import type { NextConfig } from 'next';

/**
 * O app: tudo que o navegador vê. Nenhuma rota daqui toca o estado das salas
 * nem um segredo — o que precisa disso mora no `server/`, e quem separa os dois
 * é a porta de entrada (scripts/proxy.mjs em desenvolvimento, o Caddy em
 * produção), roteando por caminho.
 *
 * Sem rewrites para o servidor, de propósito: a porta de entrada já decide o
 * roteamento antes de o Next ver o pedido, e ela também precisa repassar o
 * `upgrade` do WebSocket — coisa que rewrite de Next não faz. Duas regras de
 * roteamento em dois lugares divergem; uma só, não.
 */
/**
 * Em desenvolvimento o Next recusa pedido vindo de outra origem que não a
 * local, e pelo túnel todo pedido vem de fora. O domínio sai do PUBLIC_ORIGIN
 * em vez de ser cravado aqui: ele muda a cada túnel descartável, e um valor
 * fixo no arquivo daria "funciona na minha máquina" com o sintoma escondido
 * atrás de um aviso que ninguém lê.
 */
function origemDeDesenvolvimento(): string[] {
  const bruto = process.env.PUBLIC_ORIGIN;
  if (!bruto) return [];
  try {
    return [new URL(bruto).host];
  } catch {
    return [];
  }
}

const nextConfig: NextConfig = {
  allowedDevOrigins: origemDeDesenvolvimento(),

  // O Next escreve AGENTS.md e CLAUDE.md na pasta do app por conta própria.
  // Este repositório mantém os seus na raiz, onde valem para os dois
  // workspaces; um arquivo gerado a cada build entrando no git é ruído.
  agentRules: false,

  // Sem otimização de imagem no servidor: o app não usa next/image, e o
  // endpoint /_next/image é a superfície de várias falhas conhecidas do Next
  // (SSRF, DoS e execução remota via SVG/AVIF). Desligado, ele não existe.
  images: { unoptimized: true },

  // Não anunciar a versão do framework em cada resposta.
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // A página de captura tem o token de transmissor na query (/share?t=).
          // Sem isto, qualquer link externo clicado ali o levaria no Referer.
          { key: 'Referrer-Policy', value: 'no-referrer' },
          // HTTPS por um ano. Navegador ignora este cabeçalho em http://, então
          // não atrapalha o localhost.
          { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
          {
            // Uma Activity roda dentro de um iframe em <id>.discordsays.com,
            // que por sua vez está dentro do discord.com. Declarar essa cadeia
            // é o que autoriza o navegador a desenhar a página ali (RN-PRO-1).
            //
            // Se a borda da hospedagem carimbar "X-Frame-Options: SAMEORIGIN"
            // nas respostas, não há nada a fazer daqui: o proxy do Discord
            // repassa o X-Frame-Options da origem e substitui o CSP pelo dele,
            // então o frame-ancestors abaixo nem chega ao navegador. O sintoma
            // é retângulo branco no Discord, log limpo, e o mesmo endereço
            // funcionando quando aberto direto.
            key: 'Content-Security-Policy',
            value:
              "frame-ancestors 'self' https://discord.com https://*.discord.com https://*.discordsays.com",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
