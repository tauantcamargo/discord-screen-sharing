import { NextResponse, type NextRequest } from 'next/server';

/**
 * Barra endereços de um segmento que não são id de servidor.
 *
 * A rota `/<id do servidor>` é um segmento dinâmico na raiz, então ela casa com
 * **qualquer** caminho de um nível — um endereço digitado errado viraria uma
 * tentativa de entrar num servidor inexistente. O `notFound()` da página
 * desenha a tela certa, mas não consegue mais mudar o status: o layout é
 * `force-dynamic` (RN-SES-4) e a resposta já começou a sair quando ele dispara.
 *
 * Aqui ainda dá: isto roda antes de qualquer renderização.
 */
const GUILD_ID_PATTERN = /^\/[0-9]{15,21}$/;

/** Link fixo, `/s/<nome>` — mesmo formato que o servidor aceita. */
const FIXED_PATTERN = /^\/s\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** O que existe de verdade na raiz. Rota nova = mais uma entrada aqui. */
const KNOWN_ROUTES = new Set(['/', '/share', '/termos', '/privacidade']);

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (KNOWN_ROUTES.has(pathname) || GUILD_ID_PATTERN.test(pathname) || FIXED_PATTERN.test(pathname)) {
    return NextResponse.next();
  }

  return new NextResponse('Não encontrado.', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

export const config = {
  /**
   * Só caminhos de um segmento. Tudo que tem barra no meio — `/_next/*`,
   * `/api/avatar/*` — passa longe daqui, e o custo por requisição continua zero
   * para o que mais aparece.
   */
  matcher: ['/((?!_next|api|favicon).[^/]*)', '/s/:path*'],
};
