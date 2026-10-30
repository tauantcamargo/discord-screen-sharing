# Sala de Tela

Mostre sua tela para quem está na mesma call do Discord. Uma pessoa
compartilha, todo mundo assiste **sem sair do Discord**.

O mesmo produto funciona como site normal, fora do Discord, com salas que você
cria e compartilha por link.

> **Reescrita em andamento.** Este repositório é o porte do
> [`discord-streaming`](https://github.com/marceloedu2/discord-streaming) — que funciona
> hoje, em Vite + Express + JavaScript — para Next.js 16 + TypeScript +
> Tailwind v4. O servidor de tempo real já está de pé e testado; a interface
> ainda é um marcador. O que falta, por fase, está no
> [roadmap](.claude/specs/11-roadmap.md).

---

## Os dois contextos

O produto roda em dois lugares, com regras diferentes, e essa diferença
atravessa quase toda decisão do código:

| | **Activity** (dentro do Discord) | **Site** (fora) |
|---|---|---|
| Como entra | Foguete 🚀 no canal de voz | Abre a URL |
| Identidade | OAuth do Discord, automático | Convidado, ou login opcional |
| Salas | Não há lista — cai direto na sala da call | Lista de salas, criadas por quem quiser |
| Controle de acesso | Presença no canal de voz | Senha opcional por sala |
| Sair da sala | Fechando a Activity | Botão de sair, volta ao lobby |
| Detecção | `frame_id` presente na query | Ausente |

Dentro do Discord não existe lista de salas porque escolher entre uma opção só
não é escolha: a atividade entra direto na sala daquela call. Fora dele não há
call para herdar, então a lista é a única forma de as pessoas se encontrarem.

---

## Rodar

```bash
npm install
npm run dev
```

Abre em <http://localhost:3000>. São três processos numa janela só, e o
`Ctrl + C` derruba os três juntos.

Antes, copie `.env.example` para `.env`. Nada ali é obrigatório para subir em
localhost — sem as credenciais do Discord o site funciona no navegador
normalmente, só não abre como atividade. Para gerar o `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### Com o Hangar

Para rodar no PC emprestado em vez desta máquina:

```bash
hangar up     # sobe o docker-compose.dev.yml lá e traz a porta 3000 pra cá
hangar down   # derruba
```

Abre do mesmo jeito em <http://localhost:3000>. O Next recarrega sozinho; o
servidor de tempo real usa o `--watch` do Node, que não vê mudança de arquivo
num Docker do Windows, então mexeu em `server/`, rode `hangar up` de novo.

---

## A forma do repositório

```
                    porta de entrada (:3000)
                    scripts/proxy.mjs em dev · infra/Caddyfile em produção
                              │
             ┌────────────────┴────────────────┐
             │ roteia por caminho              │
     /ws /api/rooms /api/session        todo o resto
     /api/token /api/health /auth       /  /share  /_next/*  /api/avatar/*
             │                                 │
             ▼                                 ▼
       server/ (:3101)                   app/ (:3100)
       Node + ws, sem framework          Next 16 + TypeScript + Tailwind
```

```
app/                Next. Tudo que o navegador vê.
server/src/         relay, API de salas, OAuth, tokens
  index · http · api · relay · rooms · discord · tokens · config · types
infra/              server-paths.mjs (tabela de rotas) · Caddyfile
scripts/            up.mjs · proxy.mjs · smoke.mjs · test-frontend.mjs · hooks/
.claude/            AGENTS.md · specs/ · skills/ · settings.json
```

### Por que dois processos

A divisão não é "API de um lado, interface do outro". O critério é **quem toca
o estado em memória e quem tem um segredo**:

- O relay precisa do evento `upgrade` do servidor HTTP, que Route Handler
  nenhum expõe, e as salas vivem num `Map` que só faz sentido num processo
  único e vivo.
- `SESSION_SECRET`, `DISCORD_CLIENT_SECRET` e `DISCORD_BOT_TOKEN` moram junto
  de quem os usa.
- O que não cumpre nenhum dos dois critérios é do app — `/api/avatar/*`
  inclusive, que no projeto antigo mantinha 200 imagens em cache dentro do
  mesmo processo que faz relay de vídeo.

### Por que uma porta de entrada, e não rewrites do Next

1. **Rewrite de Next não repassa o `upgrade` do WebSocket.** O `/ws` é o
   produto inteiro deste projeto, então isso sozinho já decide.
2. O Discord aceita um URL Mapping por prefixo; dois processos sem nada na
   frente seriam dois mapeamentos para manter à mão no portal.
3. Mesma origem para tudo: nenhum CORS, um `PUBLIC_ORIGIN` só, e o front nem
   sabe que existem dois processos.

A lista de caminhos do servidor vive em
[`infra/server-paths.mjs`](infra/server-paths.mjs), lida pela porta de entrada.
O Caddy não lê JavaScript, então o [`Caddyfile`](infra/Caddyfile) repete as
mesmas entradas à mão — **rota nova são estes dois lugares.**

---

## Por que a tela é capturada numa aba separada

Duas restrições do Discord definiram o desenho inteiro:

1. **A atividade roda num iframe de outro domínio.** Nesse contexto o navegador
   nega `getDisplayMedia()` — a função que pede a tela — a menos que o Discord
   marque o iframe com `allow="display-capture"`, o que ele não faz.
2. **WebRTC não existe em atividades.** Só WebSocket é suportado. Sem P2P, sem
   SFU.

```
QUEM MOSTRA                        SERVIDOR              QUEM ASSISTE
aba normal do navegador                                  atividade (iframe)
  getDisplayMedia  ✅                                          │
  VideoEncoder                                                 │
  └──── WebSocket binário ────►  repassa sem                   │
                                 abrir o quadro ───────────────►
                                                          VideoDecoder → canvas
```

Quem assiste nunca sai do Discord; só quem mostra passa por uma aba. E a
atividade **tenta capturar internamente antes** de cair para a aba: se um dia o
Discord conceder `display-capture`, o caminho já existe e a aba some sozinha.

Até 4 transmissores por sala. Cada um recebe um `slot` (0–3) e o carimba no
primeiro byte de todo quadro; o servidor confere o carimbo contra a conexão e
descarta o que não bate, senão um cliente adulterado injetaria quadros no
stream de outra pessoa.

Três decisões que sustentam a latência, e que o porte não pode desfazer:
**keyframe sob demanda** (quem chega no meio faz o servidor pedir um quadro
novo, em vez de guardar um velho), **assistir é opt-in** (o servidor não manda
os bytes de uma tela para quem não pediu — é o que segura a banda) e
**backpressure no relay** (socket com mais de 2 MB acumulados perde quadros em
vez de enfileirar, senão um espectador com internet ruim derruba o processo).

O detalhamento está em [`.claude/specs/`](.claude/specs/).

---

## A cara é a do Discord, de propósito

A paleta não é nova — é a do Discord, herdada verbatim. Uma tela que destoa do
Discord **dentro do próprio Discord** lê como site de terceiro invadindo a
call, e a confiança cai junto. Tema escuro é o único tema: o Discord não expõe
a Activity ao tema claro do cliente. Ver
[`02-identidade-visual.md`](.claude/specs/02-identidade-visual.md).

---

## Comandos

| Comando | Para quê |
|---|---|
| `npm run dev` | Sobe entrada, app e servidor numa janela. |
| `npm start` | O mesmo, com build de produção. |
| `npm run build` | Compila o app e o servidor. |
| `npm run types` | `tsc --noEmit` nos dois workspaces. |
| `npm run lint` | `eslint` nos dois workspaces. |
| `npm run test` | Rotas × mobile/tablet/desktop × light/dark, no navegador. |
| `npm run test:fast` | Só desktop/light, para o ciclo curto. |
| `npm run smoke` | Servidor ponta a ponta, sem navegador. |
| `npm run check` | `types` + `lint` + `test`. |

O servidor roda TypeScript direto em desenvolvimento, sem passo de build; o
`tsconfig` dele cobra `erasableSyntaxOnly`, então nada que o Node não saiba
executar entra no código.

---

## Verificação

Toda mudança de front passa por navegador de verdade antes de ser dada como
pronta — não confie em "compilou". `npm run test` cobre, por combinação: status
HTTP, erros de console, exceções não capturadas, requisições com falha,
auditoria axe-core, estouro horizontal com o elemento culpado, alvos de toque
abaixo de 24px, indicador de foco visível, hierarquia de títulos, imagens
quebradas ou sem `alt`, e metadados. Fecha com Core Web Vitals por rota.

Ele bate na **porta de entrada**, não no Next: uma tela que funciona no `:3100`
e quebra pelo `:3000` é o tipo de falha que só o roteamento revela.

**Ao criar uma tela**, registre a rota em
[`scripts/routes.mjs`](scripts/routes.mjs) — é o que a suíte percorre, e rota
não registrada não é testada por ninguém.

`npm run smoke` cobre o outro lado, sem navegador: senha e bloqueio por
tentativas, "assistir é opt-in", a máquina de estados do keyframe, quadro
carimbado com slot alheio, e isolamento entre instâncias. Precisa do
`npm run dev` no ar noutra janela.

O que essas duas suítes existem para defender:

| | Alvo | Onde se mede |
|---|---|---|
| Latência de vídeo | < 300 ms na mesma rede | painel de detalhes, linha "Latência" |
| Tempo até o primeiro quadro | < 1 s após "Assistir" | keyframe sob demanda |
| Erros de console em produção | zero | `npm run test` |
| Estouro horizontal em 390px | zero | `npm run test` |
| Violações axe sérias/críticas | zero | `npm run test` |

---

## Dentro do Discord

O Discord exige registrar a aplicação no portal dele. Uma vez só:

1. **Activities → Settings** → ligue "Enable Activities".
2. **Activities → URL Mappings → Add Mapping** — `Prefix: /`, e o `Target`
   apontando para o seu endereço público (sem o `https://`).
3. **OAuth2 → Redirects** → `{PUBLIC_ORIGIN}/auth/callback`.

Um mapeamento só, com prefixo `/`, porque a porta de entrada já separa o que é
do app e o que é do servidor.

O `PUBLIC_ORIGIN` precisa ser um endereço público de verdade — o Discord não
alcança `localhost`. E ele **não pode** apontar para o domínio do proxy do
Discord: a página de captura precisa abrir fora do iframe, senão a captura
volta a ser bloqueada. O servidor recusa subir nesse caso e diz por quê.

O `DISCORD_BOT_TOKEN` é opcional e serve a uma coisa só: confirmar com o
Discord que a pessoa está mesmo no canal de voz. Sem ele o escopo cai para a
instância da atividade — que vem do cliente e, portanto, é obscuridade, não
segurança.

### O túnel

Para o Discord alcançar a sua máquina sem publicar nada:

```bash
npm run tunnel:create    # login na Cloudflare, cria o túnel, aponta o DNS
npm run tunnel           # sobe o túnel; deixe a janela aberta
```

O `tunnel:create` pede um subdomínio de um domínio já ativo na sua conta da
Cloudflare e escreve `TUNNEL_CONFIG` e `PUBLIC_ORIGIN` no `.env`. O endereço
não muda mais, então o Target no portal do Discord é configurado uma vez só.

Sem `TUNNEL_CONFIG`, o `npm run tunnel` abre um túnel descartável, com endereço
novo a cada execução — serve para testar, mas o Target muda junto.

O binário do cloudflared é baixado sob demanda para `.cache/`, então não há o
que instalar antes. O túnel aponta para a **porta de entrada**, nunca para o
app nem para o relay: é ela que roteia por caminho e repassa o `upgrade` do
WebSocket.

---

## Imagem pronta

Para quem só quer usar, sem clonar nem compilar:

```bash
docker run -d --name sala-de-tela --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -e SESSION_SECRET="$(openssl rand -base64 32)" \
  -e PUBLIC_ORIGIN=https://tela.seudominio.com \
  ghcr.io/tauantcamargo/sala-de-tela:latest
```

Ou com o [`docker-compose.hub.yml`](docker-compose.hub.yml), que traz o modelo
de `.env` comentado. Imagem para `amd64` e `arm64` (Raspberry, VPS ARM).

| Variável | Obrigatória | Para quê |
|---|---|---|
| `SESSION_SECRET` | sim | Assina sessões e tokens de sala. `openssl rand -base64 32` |
| `PUBLIC_ORIGIN` | sim | O endereço público, com `https://` e sem barra no fim |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | não | Login com o Discord (nome e foto). Redirect: `{PUBLIC_ORIGIN}/auth/callback` |
| `MAX_VIEWERS_PER_STREAM` | não | Teto de quem assiste cada tela (padrão 12) |

Coloque um proxy com HTTPS na frente da porta 3000 — Caddy, Traefik, Coolify
ou túnel da Cloudflare. O navegador só libera captura de tela em HTTPS, e o
proxy precisa repassar WebSocket em `/ws`.

**Recursos:** ~100 MB de RAM parada e CPU perto de zero; 256 MB sobra para um
grupo de amigos. O gargalo é a banda de upload do servidor: cada pessoa
assistindo recebe o vídeo inteiro de novo. Uma réplica só — as salas vivem em
memória.

**Como usar com a galera:** a voz fica na call do Discord e a tela abre no
navegador. Fixe um link por canal de voz — `https://tela.seudominio.com/s/geral`,
`/s/jogos`… — e quem abre cai direto na sala. No Brasil as Activities de vídeo
estão suspensas por ordem da ANPD, então dentro do Discord a atividade não
abre; o site funciona normalmente.

A imagem é publicada pelo workflow [`docker.yml`](.github/workflows/docker.yml)
a cada push na `main` (`latest`) e a cada tag `v*` (`1.2.3`, `1.2`, `1`).

---

## Docker

Uma imagem, dois contêineres: a aplicação e o túnel.

```bash
cp .env.example .env      # e preencha
docker compose up -d --build
```

O `TUNNEL_TOKEN` **é obrigatório** e vem de **dash.cloudflare.com → Zero Trust
→ Networks → Tunnels → o seu túnel → Configure**. É o mesmo túnel que o
`npm run tunnel:create` cria, visto pelo outro lado — se você já rodou aquele
comando, o túnel existe e só falta copiar o token.

Vazio, o contêiner do túnel reinicia em laço: sem token o `cloudflared` não tem
o que fazer. O `docker compose logs cloudflared` diz isso na primeira linha.

Quem já tem o túnel criado localmente pode pular o painel e montar as
credenciais que o `tunnel:create` deixou em `~/.cloudflared` — o bloco
comentado no fim do `docker-compose.yml` mostra como.

No painel do túnel, em **Public Hostname**, o serviço aponta para
`http://sala:3000` — `sala` é o nome do contêiner na rede do compose, e 3000 é
a porta de entrada.

O `.env` **não entra na imagem**: o `.dockerignore` o exclui de propósito, e o
compose o injeta em tempo de execução. Segredo em camada de imagem viaja junto
com ela para todo lugar onde ela for parar.

Para rodar sem túnel, descomente o bloco `ports:` do compose e abra
<http://localhost:3000>.

```bash
docker compose logs -f sala     # o que os três processos estão dizendo
docker compose ps               # inclui o healthcheck, que só passa com o relay de pé
docker compose down             # derruba tudo
```

---

## Deixar no ar

O [`Caddyfile`](infra/Caddyfile) já traz o roteamento certo e o certificado
automático. Troque o domínio, aponte para `127.0.0.1:3100` e `127.0.0.1:3101`,
e rode `npm ci && npm start`.

Duas coisas que o desenho impõe na hospedagem:

- **O servidor não escala para duas réplicas.** As salas vivem em memória; duas
  cópias teriam duas listas, e quem caísse na segunda não veria ninguém.
- **Nada de `X-Frame-Options` na borda.** Foi um header desses, posto por um
  PaaS, que impediu a atividade de abrir por um dia inteiro — o Discord embute
  a página num iframe e o navegador obedece ao header antes de qualquer coisa.
  O sintoma é cruel: retângulo branco no Discord, log limpo, e o mesmo endereço
  funcionando quando aberto direto.

---

## Estado do porte

O servidor está pronto e o `npm run smoke` prova. A interface está na **fase
1** — as rotas sobem como marcadores que dizem de onde o porte sai, para que a
diferença entre "ainda não escrevi" e "quebrou" seja visível.

Três módulos atravessam **sem reescrita** — não são interface, são pipeline de
mídia, e reescrever só introduziria regressão:

| Do [projeto antigo](https://github.com/marceloedu2/discord-streaming) | Vira | O que faz |
|---|---|---|
| `client/src/player.js` | `app/src/lib/player.ts` | decodifica vídeo e desenha no canvas |
| `client/src/audio.js` | `app/src/lib/audio.ts` | decodifica Opus e agenda a reprodução |
| `shared/broadcaster.js` | `app/src/lib/broadcaster.ts` | captura + codificação |

A tipagem entra por cima; a lógica não muda. Comportamento herdado não se
reinventa sem motivo escrito — o projeto antigo tem uma quantidade enorme de
decisão deliberada registrada em comentário.

O que o Discord tem e este produto ainda não — 14 itens levantados, de presets
de qualidade a janela destacada — está em
[`10-paridade-discord.md`](.claude/specs/10-paridade-discord.md).

---

## O que não vai existir

Registrado para ninguém tentar de novo:

- **Compartilhar do celular.** Nenhum navegador móvel expõe `getDisplayMedia`.
- **Som de programa instalado em captura de tela inteira.** O navegador entrega
  a mistura do sistema, com a saída do Discord dentro — e a call inteira passa
  a se ouvir de volta, com atraso. Não existe API web para tirar um processo
  dessa mistura. A saída é "som de uma aba": o vídeo continua sendo a tela
  inteira, e o som vem da aba que você escolher.
- **WebRTC, P2P ou SFU.** Activities só suportam WebSocket.
- **Gravar a transmissão.** Fora do escopo.
- **Escala de broadcast.** Cada espectador consome a qualidade escolhida
  inteira. Cinco pessoas a 2,5 Mb/s são 12,5 Mb/s de subida no transmissor; a
  8 Mb/s, 40 Mb/s.

E **60 fps não é garantido**: sem codificação por hardware o navegador não dá
conta de 60 quadros em tela grande e entrega menos. A página de captura avisa
quando isso acontece.

---

## Onde ler mais

| | |
|---|---|
| [`.claude/AGENTS.md`](.claude/AGENTS.md) | Como trabalhar neste repositório |
| [`01-produto.md`](.claude/specs/01-produto.md) | Visão, personas, escopo, não-objetivos |
| [`02-identidade-visual.md`](.claude/specs/02-identidade-visual.md) | Paleta, tipografia, tokens |
| [`03-restricoes-tecnicas.md`](.claude/specs/03-restricoes-tecnicas.md) | O que o Discord impõe, e por quê o desenho é este |
| [`04-identidade-e-sessao.md`](.claude/specs/04-identidade-e-sessao.md) | Login, convidado, crachá, renovação |
| [`05-lobby-e-salas.md`](.claude/specs/05-lobby-e-salas.md) | Criar, listar, entrar, senha, ciclo de vida |
| [`06-transmissao.md`](.claude/specs/06-transmissao.md) | Captura, qualidade, slots, som de aba |
| [`07-assistir-e-palco.md`](.claude/specs/07-assistir-e-palco.md) | Opt-in, palco, lateral, tela cheia |
| [`08-audio.md`](.claude/specs/08-audio.md) | Opus, colchão, volume geral e por pessoa |
| [`09-protocolo.md`](.claude/specs/09-protocolo.md) | Contrato HTTP e WebSocket — herdado, não muda |
| [`10-paridade-discord.md`](.claude/specs/10-paridade-discord.md) | O que o Discord tem hoje e nós não |
| [`11-roadmap.md`](.claude/specs/11-roadmap.md) | Ordem de implementação, por fase |

Os requisitos têm id estável, citável em commit e PR: `RF-` funcional, `RN-`
regra de negócio, `RNF-` não funcional. Cada um declara se é `herdado`,
`refinado` ou `novo`.
