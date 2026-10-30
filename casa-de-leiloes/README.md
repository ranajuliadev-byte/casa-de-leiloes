# Casa de Leilões

Casa de leilões online de **obras de arte**: um leiloeiro monta lotes a partir de obras reais do
[Art Institute of Chicago](https://api.artic.edu/docs/), licitantes depositam saldo simulado e disputam
cada lote com lances ao vivo, e qualquer pessoa, mesmo sem login, pode **auditar** o histórico de lances
e conferir que ele não foi adulterado, inclusive refazendo a verificação no próprio navegador.

> Teste técnico **Elite Dev, Verzel**.
>
> - **Aplicação (front):** https://casa-de-leiloes-tau.vercel.app
> - **API:** https://casa-de-leiloes-v4pm.onrender.com/api/health
> - **Repositório:** https://github.com/ranajuliadev-byte/casa-de-leiloes

---

## Sumário

1. [Visão geral e fluxo](#1-visão-geral-e-fluxo)
2. [Stack e por quê](#2-stack-e-por-quê)
3. [Arquitetura](#3-arquitetura)
4. [Como rodar](#4-como-rodar)
5. [Variáveis de ambiente](#5-variáveis-de-ambiente)
6. [Dados de teste e credenciais](#6-dados-de-teste-e-credenciais)
7. [Roteiro de avaliação passo a passo](#7-roteiro-de-avaliação-passo-a-passo)
8. [Regras de lance e como foram implementadas](#8-regras-de-lance-e-como-foram-implementadas)
9. [Gestão da API externa](#9-gestão-da-api-externa)
10. [Histórico à prova de adulteração](#10-histórico-à-prova-de-adulteração)
11. [Privacidade](#11-privacidade)
12. [Testes automatizados](#12-testes-automatizados)
13. [Deploy](#13-deploy)
14. [Comportamentos inesperados e decisões](#14-comportamentos-inesperados-e-decisões)
15. [Uso de IA](#15-uso-de-ia)

---

## 1. Visão geral e fluxo

| Papel | O que faz |
|---|---|
| **Leiloeiro** (vendedor) | Busca obras na API externa, cria lotes (lance inicial, incremento mínimo, início e fim), acompanha o resultado de cada lote e o total recebido, e cancela lotes ainda abertos. **Não pode dar lances.** |
| **Licitante** (cliente) | Deposita saldo simulado, acompanha os lotes ao vivo, dá lances, recebe aviso quando é superado e, se vencer, ganha um **comprovante de arremate** com link compartilhável. |
| **Qualquer pessoa** | Navega pela vitrine, abre a **auditoria pública** de um lote e confere um comprovante pelo link. |

```
Leiloeiro                         Licitante                              Público (sem login)
───────────                       ───────────                            ───────────────────
busca obra (AIC) ─┐               deposita saldo
cria lote ────────┼──► VITRINE ◄── escolhe lote
                  │      │
                  │      ▼
                  │   SALA AO VIVO ◄─ dá lance ─► aceito? ──► saldo comprometido
                  │      │ (WebSocket)            recusado ──► motivo na tela
                  │      ▼
                  │   fim do lote (+2 min a cada lance nos 2 min finais)
                  │      │
                  │      ▼
                  └─► LIQUIDAÇÃO ─► débito do vencedor + crédito do leiloeiro
                                    + COMPROVANTE assinado ─────────────► /comprovante/<código>
                                                                          /auditoria/<lote>
```

### Telas

| Rota | Tela | Acesso |
|---|---|---|
| `/` | **Vitrine**: abas Ao vivo / Agendados / Encerrados, busca por título ou artista, ordenação, atualização em tempo real | público |
| `/lotes/[id]` | **Sala do lote**: lance atual, próximo mínimo, contagem regressiva, "Você está ganhando" / "Você foi superado", posição, histórico ao vivo e formulário de lance | público (lance só para licitante) |
| `/entrar`, `/cadastro` | Login e cadastro, com escolha de papel | público |
| `/carteira` | Saldo total, comprometido e disponível, depósito simulado e extrato | licitante |
| `/meus-arremates` | Lotes em que deu lance e lotes vencidos, com comprovante e link de compartilhamento | licitante |
| `/painel` | Painel do leiloeiro: totais (vendidos, não vendidos, ao vivo, agendados, **total recebido**), resultado de cada lote e cancelamento | leiloeiro |
| `/painel/novo` | Busca na API externa e criação de lote | leiloeiro |
| `/auditoria/[id]` | **Auditoria pública**: selo ÍNTEGRO / ADULTERADO, cadeia de lances e "Verificar no meu navegador" | público |
| `/comprovante/[code]` | **Comprovante de arremate** compartilhável, com selo de validade | público |

> Prints: `<preencher: capturas de tela da vitrine, sala ao vivo, auditoria e comprovante>`

---

## 2. Stack e por quê

| Camada | Tecnologia | Por quê |
|---|---|---|
| Front-end | **Next.js 15** (App Router) + **React 19** + **Tailwind v4** | React é obrigatório; o App Router dá rotas por arquivo e um build standalone simples de containerizar. Tailwind v4 deixa o dark mode (`next-themes`) barato. |
| Tempo real | **Socket.IO** | Reconexão automática, salas por lote (`lot:<id>`) e fallback para long-polling. Ao reconectar, o front busca de novo o estado autoritativo pela API REST. |
| Back-end | **NestJS 11** (Node 22, TypeScript) | Módulos, injeção de dependência (inclusive de um `Clock` controlável nos testes), guards de papel e gateway WebSocket integrados. |
| Banco | **PostgreSQL 16** | Transações ACID e `SELECT … FOR UPDATE`, essenciais para lances concorrentes e saldo comprometido. |
| ORM | **Prisma 6** com driver adapter `pg` | Tipos gerados a partir do schema e migrations versionadas. O client "Rust-free" (`engineType = "client"`) não depende de binário de query engine em runtime. |
| Cripto | `node:crypto` (SHA-256, Ed25519, HMAC) | Nada de dependência externa para a parte de segurança; o navegador verifica com WebCrypto. |
| Testes | Jest + Supertest + socket.io-client | Testes de integração contra um Postgres real, para exercitar locks e concorrência de verdade. |

---

## 3. Arquitetura

```mermaid
flowchart LR
  subgraph Browser
    UI["Next.js (React 19)"]
    WC["WebCrypto<br/>(verificação da auditoria)"]
  end

  subgraph API["API NestJS (:3001/api)"]
    AUTH[Auth / JWT]
    WAL[Carteira]
    ART["Obras<br/>(timeout · retry · circuit breaker · cache)"]
    LOTS[Lotes / Vitrine / Painel]
    BIDS["Lances<br/>(lock + anti-sniping)"]
    SET["Liquidação<br/>(job a cada 2 s)"]
    AUD[Auditoria]
    REC[Comprovantes]
    RT[["Gateway Socket.IO"]]
    CRY["audit-crypto<br/>(SHA-256 · Ed25519 · HMAC)"]
  end

  DB[(PostgreSQL)]
  AIC[(API Art Institute<br/>of Chicago)]
  CDN[(Wikimedia Commons<br/>imagens)]

  UI -- REST --> API
  UI <-- "lot:state · lot:bid · user:*" --> RT
  UI -. imagens .-> CDN
  WC -. payloads + chave pública .-> AUD
  ART -- HTTPS --> AIC
  BIDS --> CRY
  SET --> CRY
  AUD --> CRY
  REC --> CRY
  AUTH & WAL & ART & LOTS & BIDS & SET & AUD & REC --> DB
  BIDS & SET & LOTS --> RT
```

### Estrutura do repositório

```
.
├── backend/                 API NestJS
│   ├── prisma/
│   │   ├── schema.prisma    modelo de dados (dinheiro em centavos, Int)
│   │   ├── migrations/      migrations SQL versionadas
│   │   └── seed.ts          dados de demonstração (cadeias válidas e carteiras coerentes)
│   ├── src/
│   │   ├── common/          clock, erros, fase do lote, cripto da auditoria, views
│   │   ├── auth/ users/ wallet/ artworks/ lots/
│   │   ├── bids/            motor de lances (lock, saldo comprometido, anti-sniping)
│   │   ├── settlement/      liquidação + comprovante
│   │   ├── audit/ receipts/ me/ realtime/ health/
│   │   └── main.ts
│   ├── test/                testes de integração (e2e) e unitários
│   ├── Dockerfile
│   └── docker-entrypoint.sh
├── frontend/                Next.js (App Router)
│   ├── src/app/             rotas (ver tabela acima)
│   ├── src/components/      telas e componentes
│   ├── src/lib/             api, socket, relógio, formatação, verificação WebCrypto
│   └── Dockerfile
├── docs/CONTRATO.md         contrato REST/WebSocket entre front e back
├── docker-compose.yml
└── render.yaml              Blueprint de deploy da API (Render)
```

### Modelo de dados (resumo)

- `User` (papel `AUCTIONEER` | `BIDDER`) → `Wallet` (`balanceCents`, `committedCents` em BigInt; head do extrato assinado: `ledgerCount`, `ledgerHead`, `ledgerSignature`) → `LedgerEntry` (extrato encadeado por carteira, só inserção: `seq`, `prevHash`, `hash`, `bidHash`; tipos `DEPOSIT`, `COMMIT`, `RELEASE`, `SETTLEMENT_DEBIT`, `SETTLEMENT_CREDIT`).
- `Artwork`: cache local das obras da API externa.
- `Lot`: **snapshot** da obra (título, imagem, atributos), regras do pregão, estado desnormalizado (preço atual, líder, nº de lances, fim vigente) e **âncora da auditoria** (`genesisHash`, `headHash`, `headSignature`, `cancelSignature`).
- `Bid`: elo da cadeia (`sequence`, `prevHash`, `hash`, `signature`, `bidderAlias`), só inserção.
- `Receipt`: comprovante assinado (código público, pseudônimo do vencedor, valor, head da cadeia).

Todo valor monetário é **inteiro em centavos**; datas são ISO 8601 em UTC. Saldos de carteira são `BIGINT` no banco (o leiloeiro acumula créditos) e `number` na API.

---

## 4. Como rodar

### Opção A: Docker Compose (recomendado)

Pré-requisitos: Docker com Compose v2.

```bash
docker compose up --build
```

| Serviço | URL |
|---|---|
| Front | http://localhost:3000 |
| API | http://localhost:3001/api (saúde: `/api/health`) |
| Postgres | `localhost:5432` (usuário `postgres`, senha `postgres`, base `leiloes`) |

> **Segredos:** sem `.env`, o Compose usa `JWT_SECRET`/`AUDIT_SECRET` de exemplo (públicos) com `NODE_ENV=development`, só para a demonstração local; a API registra um aviso no log. Para qualquer uso real, crie um `.env` na raiz com `JWT_SECRET` e `AUDIT_SECRET` aleatórios (`openssl rand -base64 32`) e `NODE_ENV=production`; nesse modo a API não sobe com segredo ausente, curto ou de exemplo.

Na primeira subida, o container da API roda `prisma migrate deploy` e o **seed** (com `SEED=true`, o padrão, ele só semeia se o banco estiver vazio). Para **recriar a demonstração** (por exemplo, para "rebobinar" o lote que termina em 10 minutos):

```bash
SEED=force docker compose up -d --force-recreate api      # recria os dados a cada subida da API
# ou, com tudo no ar:
docker compose exec api npx ts-node prisma/seed.ts
```

As credenciais e os links do seed aparecem em `docker compose logs api`.

> Para zerar tudo, inclusive o volume do banco: `docker compose down -v`.

### Opção B: manual (Postgres local)

Pré-requisitos: **Node 22+**, **npm 10+** e **PostgreSQL 14+** rodando localmente.

```bash
# 1) Banco
createdb leiloes                     # ou: psql -U postgres -c 'CREATE DATABASE leiloes'

# 2) API
cd backend
cp .env.example .env                 # ajuste DATABASE_URL se o seu Postgres for diferente
npm ci
npx prisma generate
npx prisma migrate deploy            # cria as tabelas
npm run db:seed                      # dados de demonstração (imprime credenciais e links)
npm run start:dev                    # API em http://localhost:3001/api

# 3) Front (em outro terminal)
cd frontend
cp .env.example .env.local           # NEXT_PUBLIC_API_URL=http://localhost:3001
npm ci
npm run dev                          # http://localhost:3000
```

Build de produção: `cd backend && npm run build && npm run start:prod` (aplica as migrations e sobe `dist/main.js`) e `cd frontend && npm run build && npm start`.

---

## 5. Variáveis de ambiente

### API (`backend/.env`, modelo em `backend/.env.example`)

| Variável | Obrigatória | Padrão / exemplo | Descrição |
|---|---|---|---|
| `DATABASE_URL` | sim | `postgresql://postgres:postgres@localhost:5432/leiloes?schema=public` | Conexão com o PostgreSQL. |
| `DATABASE_CA_CERT` | não | — | Certificado PEM da CA do banco, para validar o TLS quando ela não é pública (ex.: Supabase). |
| `PORT` | não | `3001` | Porta HTTP e WebSocket da API. |
| `NODE_ENV` | não | `development` | Com `production`, a API **recusa subir** se `JWT_SECRET` ou `AUDIT_SECRET` estiverem ausentes, tiverem menos de 16 caracteres ou forem um dos valores de exemplo públicos deste repositório. Fora de produção ela usa um padrão de desenvolvimento e registra um aviso. A imagem Docker da API já define `production`; o `docker-compose.yml` sobrescreve para `development` (ver Opção A). |
| `JWT_SECRET` | sim (produção) | (≥ 16 caracteres, aleatório) | Assina os tokens de acesso (validade de 7 dias). |
| `AUDIT_SECRET` | sim (produção) | (≥ 16 caracteres, aleatório) | Deriva a **chave Ed25519** da auditoria e a chave **HMAC** dos pseudônimos. Não fica no banco. **Não troque depois de haver lances**: as assinaturas antigas deixariam de validar. Gere com `openssl rand -base64 32`. |
| `TRUST_PROXY` | não | `1` no Render (variável `RENDER`), `loopback` fora | Saltos de proxy confiáveis para obter o IP real (rate limit por IP). Defina só se houver proxy na frente: sem proxy, confiar no `X-Forwarded-For` deixa o cliente forjar o IP e burlar o rate limit. |
| `CORS_ORIGIN` | sim | `http://localhost:3000` | Origens do front permitidas (separadas por vírgula). |
| `FRONTEND_URL` | sim | `http://localhost:3000` | Base dos links públicos (comprovante e auditoria). |
| `ARTWORKS_API_URL` | não | `https://api.artic.edu/api/v1` | API pública de obras. |
| `TEST_DATABASE_URL` | não | `postgresql://postgres:postgres@localhost:5432/leiloes_test?schema=public` | Banco usado por `npm test`. |
| `SEED` | não (só Docker) | `true` | `true`: semeia se o banco estiver vazio. `force`: recria a cada subida. Outro valor: não semeia. |
| `ALLOW_DEMO_SEED` | não | — | Com `NODE_ENV=production`, o seed só roda se for `true` (as contas de demonstração têm senha pública). O `render.yaml` define `true` por ser um deploy de demonstração. |
| `AUTH_RATE_LIMIT` | não | `10` | Máximo por minuto por IP em cada rota pública de autenticação: login, cadastro, pedido e redefinição de senha (cada rota conta separado). O limite global das outras rotas é 600/min. |
| `AUDIT_RATE_LIMIT` | não | `60` | Máximo de chamadas por minuto por IP a `GET /api/audit/lots/:id` e a `GET /api/receipts/:code` (cada rota conta separado). |
| `LEDGER_CHECK_ON_BOOT` | não | `true` | Roda a verificação completa dos extratos (hash de cada lançamento) logo ao subir; depois ela roda a cada 1 min. Os testes usam `false`. |
| `ARTWORK_SEARCH_RATE_LIMIT` | não | `30` | Máximo de buscas de obras por minuto por IP (cada busca vai à API externa). |
| `SMTP_HOST` | não | — | Servidor SMTP para o e-mail de recuperação de senha. Sem ele: fora de produção, o link aparece no log da API; em produção, o e-mail não é enviado (só um aviso no log). |
| `SMTP_PORT` / `SMTP_SECURE` | não | `587` / `false` | Porta do SMTP e se usa TLS direto (`true`, normalmente porta 465). |
| `SMTP_USER` / `SMTP_PASS` | não | — | Credenciais do SMTP. |
| `MAIL_FROM` | não | `Casa de Leilões <no-reply@casadeleiloes.dev>` | Remetente dos e-mails. |

### Front (`frontend/.env.local`, modelo em `frontend/.env.example`)

| Variável | Obrigatória | Exemplo | Descrição |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | sim | `http://localhost:3001` | URL da API **sem** `/api`, usada para REST e Socket.IO. É embutida no bundle no momento do **build**. |

---

## 6. Dados de teste e credenciais

Senha de **todos** os usuários: **`leilao123`**

| Papel | E-mail | Situação inicial |
|---|---|---|
| Leiloeiro | `leiloeiro@leilao.dev` | Dono de todos os lotes; já recebeu R$ 4.200,00 de um arremate |
| Licitante **e** leiloeira | `ana@leilao.dev` | Depositou R$ 50.000,00; lidera um lote e já arrematou outro. A conta tem os dois perfis: no login, escolha "Comprador" ou "Leiloeiro" (ou troque pelo botão no topo) |
| Licitante | `bruno@leilao.dev` | Depositou R$ 50.000,00; lidera um lote |

Lotes criados pelo seed (horários **relativos ao momento em que o seed roda**):

| Obra | Situação | Para que serve |
|---|---|---|
| *A Sunday on La Grande Jatte*, Seurat | **Ao vivo**, termina em 14 dias, 5 lances alternados, **Ana lidera** (R$ 8.000) | Sala ao vivo, lance do Bruno, "você foi superado" |
| *The Bedroom*, Van Gogh | **Ao vivo**, termina em 14 dias, 3 lances, **Bruno lidera** (R$ 10.500) | Visão do outro licitante |
| *American Gothic*, Grant Wood | **Ao vivo, termina ~10 min após o seed**, sem lances | **Anti-sniping** |
| *The Great Wave*, Hokusai | **Agendado**, começa 1 h após o seed | Recusa "lote ainda não iniciado" |
| *Paris Street; Rainy Day*, Caillebotte | **Agendado**, começa 1 dia após o seed | Aba Agendados |
| *Water Lilies*, Monet | **Encerrado e liquidado**, **Ana venceu** (R$ 4.200), comprovante emitido | Comprovante, extrato e painel |
| *Stacks of Wheat*, Monet | **Encerrado sem lances** | Fechado sem vencedor |
| *Two Sisters*, Renoir | **Cancelado** com lances (Bruno liderava e foi estornado) | Não aparece na vitrine; auditoria segue ÍNTEGRA |

Situação das carteiras após o seed:

- **Ana:** total R$ 45.800 (50.000 − 4.200 do arremate), comprometido R$ 8.000, disponível R$ 37.800.
- **Bruno:** total R$ 50.000, comprometido R$ 10.500, disponível R$ 39.500.

Ao final, o seed imprime os links da sala, da auditoria e do **comprovante** (`/comprovante/<código>`); o código também aparece em **Meus arremates** da Ana.

**Obras:** com internet, o seed busca os dados reais das obras na API do AIC (timeout de 5 s). Sem acesso, usa um **snapshot embutido** no próprio `seed.ts`, que é o mesmo caminho do fallback da aplicação. Se a imagem de alguma obra do snapshot não carregar, o front mostra um placeholder.

> O seed **apaga e recria** todos os dados. Rode de novo quando quiser "rebobinar" a demonstração (por exemplo, depois que o lote de 10 minutos terminar): `cd backend && npm run db:seed`.

---

## 7. Roteiro de avaliação passo a passo

> Dica: use **duas janelas** (uma normal e uma anônima) para ver duas pessoas ao mesmo tempo.

1. **Vitrine (sem login):** abra http://localhost:3000. Veja as abas Ao vivo (3), Agendados (2) e Encerrados (2). O lote cancelado não aparece. Teste a busca ("Monet") e a ordenação.
2. **Entrar como Ana** (`ana@leilao.dev` / `leilao123`) na janela 1. O saldo disponível aparece no topo. Abra *A Sunday on La Grande Jatte*: indicador **"Você está ganhando"**, posição 1 e o histórico com os seus lances destacados.
3. **Recusas com motivo:**
   - Tente cobrir o próprio lance → *"Você já está ganhando este lote"*.
   - Abra *The Bedroom* e dê um lance abaixo do mínimo → *"Lance abaixo do mínimo"*, com o valor mínimo.
   - Dê um lance acima do disponível (por exemplo, R$ 45.000) → *"Saldo insuficiente"*, com o disponível.
   - Abra *The Great Wave* (agendado) → *"Este lote ainda não foi iniciado"*.
   - Abra *Water Lilies* (encerrado) → *"Este lote já foi encerrado"*.
4. **Entrar como Bruno** (`bruno@leilao.dev`) na janela 2, na mesma sala da *Grande Jatte*, e dê o lance mínimo. **Sem recarregar:**
   - Na janela da Ana, o indicador muda para **"Você foi superado"**, aparece um aviso e o novo lance entra no histórico.
   - A carteira da Ana (`/carteira`) mostra o valor voltando ao disponível (entrada `RELEASE`). A do Bruno mostra `COMMIT`.
5. **Anti-sniping:** abra *American Gothic* (termina ~10 min após o seed). Quando faltarem **menos de 2 minutos**, dê um lance: o fim passa a ser **agora + 2 min** e o lote ganha o selo "Prorrogado" (na vitrine também). Cada novo lance na janela final prorroga de novo. Quando o tempo acabar, em até ~2 s o lote é liquidado: o vencedor recebe o aviso e o comprovante aparece em *Meus arremates*.
   > Se os 10 minutos já passaram, rode o seed de novo (`npm run db:seed` ou `SEED=force`).
6. **Auditoria pública (sem login):** na sala, clique em "Auditar histórico" (ou abra `/auditoria/<id>`). Selo **ÍNTEGRO**, cadeia com hash, pseudônimo e ✓ por verificação. Clique em **"Verificar no meu navegador"**: o navegador recalcula os SHA-256 e confere as assinaturas Ed25519 com a chave pública, sem confiar no servidor.
7. **Adulterar direto no banco e ver ADULTERADO:**

   ```bash
   # Docker:
   docker compose exec db psql -U postgres -d leiloes
   # Local:
   psql postgresql://postgres:postgres@localhost:5432/leiloes
   ```

   ```sql
   -- Ache o id do lote:
   SELECT id, title, "bidCount" FROM "Lot" ORDER BY title;

   -- Ataque 1: alterar o valor de um lance (troque <LOT_ID>)
   UPDATE "Bid" SET "amountCents" = "amountCents" + 100000
    WHERE "lotId" = '<LOT_ID>' AND sequence = 2;

   -- Ataque 2: apagar o último lance
   DELETE FROM "Bid" WHERE "lotId" = '<LOT_ID>'
      AND sequence = (SELECT max(sequence) FROM "Bid" WHERE "lotId" = '<LOT_ID>');

   -- Ataque 3: trocar o lance inicial do lote
   UPDATE "Lot" SET "startingPriceCents" = 100 WHERE id = '<LOT_ID>';

   -- Ataque 4: encerrar o pregão antes da hora
   UPDATE "Lot" SET "endsAt" = now() + interval '1 minute' WHERE id = '<LOT_ID>';

   -- Ataque 5: "cancelar" o lote por fora do sistema
   UPDATE "Lot" SET "cancelledAt" = now() WHERE id = '<LOT_ID>';
   ```

   Recarregue `/auditoria/<LOT_ID>`: selo **ADULTERADO**, com a lista de problemas (`HASH_MISMATCH`, `HEAD_MISMATCH`, `COUNT_MISMATCH`, `GENESIS_MISMATCH`, `END_MISMATCH`, `CANCEL_SIGNATURE_INVALID`, `LEDGER_MISMATCH`…) e o elo afetado marcado. Fazendo isso no lote *Water Lilies*, o **comprovante** passa a mostrar **inválido**. Para voltar ao normal: `npm run db:seed`.
8. **Comprovante:** como Ana, abra **Meus arremates → Arrematados → *Water Lilies***. Veja o comprovante, **copie o link** e abra numa janela anônima: ele é público, mostra só o pseudônimo do vencedor e traz o selo de validade e o link para a auditoria.
9. **Painel do leiloeiro** (`leiloeiro@leilao.dev`): totais (1 vendido, 1 não vendido, 3 ao vivo, 2 agendados, **total recebido R$ 4.200**), resultado de cada lote e o extrato com `SETTLEMENT_CREDIT` em `/carteira`.
10. **Criar lote:** *Painel → Novo lote*, busque "cat" ou "Hopper", escolha a obra, defina lance inicial, incremento e datas (início "agora" = nasce ao vivo). Se a API externa estiver fora, aparece o aviso "API externa instável, exibindo obras do cache" e a busca continua funcionando com o cache.
11. **Cancelamento com estorno:** no painel, cancele *The Bedroom* (Bruno lidera). Confirme. O lote some da vitrine, a carteira do Bruno recebe a entrada `RELEASE` ("Estorno: lote cancelado") e o comprometido volta ao disponível. A auditoria do lote continua **ÍNTEGRA**: o histórico não é apagado.
12. **Dark mode:** botão de tema no cabeçalho.

---

## 8. Regras de lance e como foram implementadas

Código: `backend/src/bids/bids.service.ts` e `backend/src/common/tx-utils.ts`.

### Ordem de checagem (dentro da transação, depois do lock)

```
papel (leiloeiro não dá lance) → valor (inteiro > 0 em centavos)
  → lote existe / cancelado → fase (não iniciado / encerrado)
  → já é líder → mínimo → saldo disponível
```

Cada recusa tem um código (`AUCTIONEER_CANNOT_BID`, `INVALID_AMOUNT`, `LOT_NOT_FOUND`, `LOT_CANCELLED`, `LOT_NOT_STARTED`, `LOT_ENDED`, `ALREADY_WINNING`, `BELOW_MINIMUM` com `details.minimumCents`, `INSUFFICIENT_BALANCE` com `details.availableCents`) e uma mensagem em pt-BR, que o front mostra inline.

### Concorrência: lock pessimista por lote

1. `prisma.$transaction` + `SELECT … FROM "Lot" WHERE id = $1 FOR UPDATE`. Todos os lances do **mesmo lote** ficam **serializados**: o segundo espera o primeiro terminar e então lê o preço e o líder já atualizados (READ COMMITTED relê a versão nova).
2. O **"agora" é lido depois do lock**: a fase (ao vivo, encerrado) é avaliada no instante em que o lance realmente entra na fila do lote.
3. As carteiras envolvidas (licitante e líder anterior) são travadas com `SELECT … FOR UPDATE` **em ordem crescente de id**. Com a ordem global fixa, não há deadlock entre lances simultâneos em lotes diferentes.
4. `@@unique([lotId, sequence])` no banco é a última defesa: dois lances nunca ocupam a mesma posição da cadeia. Erros transitórios (serialização, deadlock, unique) disparam um retry da transação inteira (`withTxRetry`).
6. Toda transação interativa do projeto (lance, liquidação, cancelamento, depósito, cadastro, leitura da auditoria) usa as mesmas opções (`backend/src/common/tx-options.ts`: `maxWait` 10 s para esperar conexão do pool sob rajada, `timeout` 15 s). Com o padrão do Prisma (2 s), 40 cadastros simultâneos geravam 500 "Unable to start a transaction in the given time".
5. Os eventos WebSocket só são emitidos **depois do commit**: ninguém vê um lance que poderia ser desfeito.

Os testes de concorrência disparam dezenas de lances simultâneos e conferem que o preço final, a cadeia e o saldo comprometido batem.

### Saldo comprometido

- `disponível = balanceCents − committedCents`.
- Lance aceito: `committedCents += valor` do novo líder (entrada `COMMIT`), e o líder anterior tem `committedCents −= valor anterior` (entrada `RELEASE`), **na mesma transação**.
- O lance só é aceito se `valor ≤ disponível`. Um licitante pode liderar vários lotes ao mesmo tempo: cada um compromete o seu valor.
- Liquidação: o vencedor perde o valor do **total e do comprometido** (`SETTLEMENT_DEBIT`) e o leiloeiro ganha no total (`SETTLEMENT_CREDIT`).
- Todo lançamento passa por `appendLedger` (`backend/src/common/ledger.ts`), que trava a carteira, encadeia o lançamento no extrato daquela carteira e regrava o head assinado (nº de lançamentos, último hash, saldo e comprometido). Os lançamentos de lote guardam o hash do lance a que se referem (`bidHash`).
- Cancelamento com lances: o líder é estornado (`RELEASE`, "Estorno: lote cancelado").

### Anti-sniping

Se o lance é aceito com `endsAt − agora ≤ 2 min`, então `endsAt = agora + 2 min`. O fim original fica guardado em `originalEndsAt` (e é ele que entra no hash gênese). `extended = endsAt > originalEndsAt` alimenta o selo "Prorrogado". O front calcula a contagem regressiva com o **relógio do servidor** (`serverTime` em toda resposta), sem depender do relógio do usuário.

### Liquidação

Um job (`@Interval`, a cada **2 s**) procura lotes com `endsAt ≤ agora`, não liquidados e não cancelados. Cada lote é liquidado numa transação com `FOR UPDATE SKIP LOCKED`: se um lance está em andamento, o lote fica para o próximo ciclo, porque o lance pode prorrogá-lo. Dentro do lock, tudo é checado de novo (já liquidado? prorrogado? cancelado?), então a liquidação é **idempotente** e segura mesmo com mais de uma instância. Sem lances, o lote fecha sem vencedor.

**Falha isolada por lote:** cada lote tem sua própria transação e seu próprio `try/catch`. Se um falhar (por exemplo, estouro do saldo do leiloeiro, ver seção 14), a transação dele é desfeita por inteiro, o erro é logado e os demais lotes do ciclo são liquidados normalmente. Depois de 3 falhas seguidas, o lote só é re-tentado a cada ~1 min, para não inundar o log.

---

## 9. Gestão da API externa

Código: `backend/src/artworks/` (`aic.client.ts`, `artworks.service.ts`, `circuit-breaker.ts`).

A API do Art Institute of Chicago é pública, sem chave, com limite de requisições. A aplicação **não fica inutilizável se ela cair**:

| Camada | Comportamento |
|---|---|
| **Timeout** | 5 s por requisição (`AbortController`). |
| **Retry** | 1 nova tentativa com backoff curto, só para erros transitórios (rede, timeout, 429, 5xx). Um 404 não é repetido. |
| **Circuit breaker** | Depois de 3 falhas seguidas, abre por 30 s e vai direto ao cache sem esperar timeouts. Em seguida libera uma chamada de teste (meio-aberto): se der certo, fecha; se falhar, reabre. |
| **Cache em memória** | Resultados de busca por 10 min (até 500 consultas). |
| **Cache no banco** | Toda obra vista é gravada na tabela `Artwork`. Se a API cair, a busca responde **200** com resultados do banco (`source: 'cache'`, `degraded: true`) e o painel mostra um aviso. **Nunca 500.** |
| **Snapshot no lote** | Ao criar o lote, título, imagem e atributos são **copiados** para o próprio lote. Vitrine, sala, auditoria e comprovante **não dependem mais** da API externa. |
| **Imagens** | Pelo Wikimedia Commons: o Wikidata liga cada obra do AIC (P4610) à sua imagem (P18). O CDN IIIF do AIC passou a bloquear `<img>` com desafio anti-bot do Cloudflare; ele fica só como reserva para obras sem correspondência no Wikidata. Se a imagem falhar, o front mostra um placeholder e a página segue funcionando. |

Criar um lote com uma obra que **não está no cache** enquanto a API está fora responde `503 EXTERNAL_API_UNAVAILABLE` com mensagem clara. Obras já vistas continuam disponíveis.

---

## 10. Histórico à prova de adulteração

Código: `backend/src/common/crypto/audit-crypto.ts` (primitivas) e `backend/src/audit/audit.service.ts` (verificação).

### A técnica: cadeia de hashes + assinaturas digitais + head assinado

Cada lote tem uma cadeia no estilo blockchain, sem mineração:

```
genesis  = SHA-256( ["GENESIS", lotId, título, descrição, imagem, atributos*, vendedor**, lanceInicial, incremento, início, fimOriginal] )
lance 1  = SHA-256( ["BID", lotId, 1, pseudônimo, valor, horário, genesis] )      + Ed25519(hash)
lance 2  = SHA-256( ["BID", lotId, 2, pseudônimo, valor, horário, hash do lance 1] ) + Ed25519(hash)
   …
head     = Ed25519( ["HEAD", lotId, quantidadeDeLances, hash do último lance] )   ← gravado no lote
cancelamento = Ed25519( ["CANCEL", lotId, cancelledAt, nºLances, head] )                 ← gravado no lote
comprovante = Ed25519( ["RECEIPT", código, lotId, pseudônimo, valor, nºLances, head, emitidoEm] )

extrato (por carteira):
lançamento k = SHA-256( ["LEDGER", carteira, k, tipo, valor, lotId, hashDoLance, data, descrição, hash do lançamento k−1] )
head da carteira = Ed25519( ["WALLET_HEAD", carteira, dono, nºLançamentos, último hash, saldo, comprometido] )
```

\* atributos da obra em JSON com **chaves ordenadas recursivamente** (o `jsonb` do Postgres reordena chaves; sem isso o hash mudaria sozinho).
\*\* HMAC do leiloeiro (não expõe o id): trocar o dono do lote para desviar o crédito da venda quebra o gênese.

**Fim do pregão derivado da cadeia.** O fim original está no gênese e o horário de cada lance está no hash assinado, então o fim vigente é recalculável: começa em `originalEndsAt` e, para cada lance em ordem, se `fim − horário ≤ 2 min`, `fim = horário + 2 min`. O `endsAt` salvo é só um cache e precisa ser **exatamente** esse valor (inclusive em lote em andamento). Cada lance também precisa estar em `início ≤ horário < fim vigente naquele momento`.

**Extrato cruzado com a cadeia.** Para um lote com lances b1…bn, o extrato precisa conter exatamente: um `COMMIT` por lance (mesmo valor, carteira do autor, `bidHash` = hash do lance); um `RELEASE "Lance superado"` para cada lance superado, ligado ao lance que o superou; no lote liquidado, `SETTLEMENT_DEBIT` (vencedor) e `SETTLEMENT_CREDIT` (leiloeiro) do último lance; no cancelado, o `RELEASE` de estorno. Além disso, a cadeia do extrato de cada carteira envolvida é verificada lançamento a lançamento, e todas as carteiras da plataforma passam por uma checagem agregada (contagem, último hash, soma = saldo, head assinado).

**Por que encadear o extrato em vez de só assinar cada lançamento.** A revisão sugeria assinar cada `COMMIT` com o hash do lance. Assinatura isolada impede *alterar* ou *inventar* um lançamento, mas não impede *apagar*: no ataque de rollback, quem apaga os lances apaga junto os `COMMIT`/`RELEASE` deles, e o que sobra continua com assinaturas válidas. Com a cadeia por carteira e o head assinado (que também cobre o saldo), apagar do meio quebra o encadeamento, apagar do fim quebra o head, e mexer no saldo para "fechar a conta" quebra a assinatura. É o mesmo desenho da cadeia de lances, aplicado ao dinheiro.

- A **chave privada Ed25519** é derivada de `AUDIT_SECRET` (variável de ambiente). Ela **não fica no banco**.
- A **chave pública** é publicada em `GET /api/audit/public-key`.
- A auditoria **não confia em nenhuma flag gravada**: a cada acesso, recalcula tudo a partir dos dados crus do banco, numa leitura consistente (REPEATABLE READ).
- O botão **"Verificar no meu navegador"** refaz os SHA-256 e as verificações Ed25519 com **WebCrypto**, usando só os payloads e a chave pública. Assim, nem o próprio servidor precisa ser confiável para essa checagem.

### O que cada ataque quebra

| Ataque (direto no banco) | Detectado por |
|---|---|
| Alterar valor, autor ou horário de um lance | hash recalculado ≠ hash salvo (`HASH_MISMATCH`) |
| Recalcular o hash do lance alterado | próximo elo aponta para o hash antigo (`LINK_BROKEN`) e a assinatura não confere (`BAD_SIGNATURE`) |
| Recalcular **todos** os hashes da cadeia | as assinaturas Ed25519 não conferem: sem `AUDIT_SECRET`, ninguém assina |
| Remover um lance do meio | buraco na sequência + elo quebrado (`SEQUENCE_GAP`, `LINK_BROKEN`) |
| Remover o(s) **último(s)** lance(s) | head assinado não bate com o último lance (`HEAD_MISMATCH`, `COUNT_MISMATCH`) |
| Inserir lance falso | sem assinatura válida e/ou quebra do encadeamento |
| Trocar o autor de um lance (outro `bidderId`) | pseudônimo ≠ HMAC(lote, autor) (`ALIAS_MISMATCH`) |
| Alterar título, descrição, imagem, atributos, dono, lance inicial, incremento ou datas do lote | gênese recalculado não bate (`GENESIS_MISMATCH`) |
| Alterar `endsAt` (prorrogar, antecipar, desfazer a prorrogação) | fim recalculado pela cadeia não bate (`END_MISMATCH`) |
| Aceitar um lance fora do horário (antes do início, depois do fim) | `BID_OUTSIDE_WINDOW` |
| Cancelar pelo banco (`cancelledAt = now()`), mudar a data ou "descancelar" | assinatura do cancelamento (`CANCEL_SIGNATURE_INVALID`) e, se havia lances, o estorno no extrato (`LEDGER_MISMATCH`) |
| **Rollback**: apagar os últimos lances e restaurar no lote um head anterior (bidCount, headHash, headSignature, preço e líder antigos, todos públicos) | a cadeia fica coerente, mas o extrato não: sobram `COMMIT`/`RELEASE` ligados a lances que sumiram (`LEDGER_MISMATCH`) |
| Rollback apagando também os lançamentos do lote | cadeia/head assinado do extrato das carteiras (`LEDGER_CHAIN_BROKEN`) |
| Alterar saldo de uma carteira ou um lançamento do extrato | head assinado da carteira / hash do lançamento (`LEDGER_CHAIN_BROKEN`, `LEDGER_MISMATCH`) |
| Alterar preço atual, líder, vencedor ou valor final do lote | divergência com o último lance (`PRICE_MISMATCH`, `LEADER_MISMATCH`, `RESULT_MISMATCH`) |
| Lances fora da regra (valor menor que o anterior + incremento) | `AMOUNT_NOT_INCREASING` / `AMOUNT_BELOW_MINIMUM` |
| Alterar um comprovante | assinatura do comprovante e/ou head divergente (`valid: false`) |

### Limitações (honestas)

- **Rollback consistente de TODO o estado não é detectável só com o banco.** Quem tem acesso total ao banco (mas não à chave) não consegue *criar* estados novos, mas consegue *voltar* a um estado anterior inteiro que o próprio servidor assinou: restaurar um backup de ontem, ou reverter juntos lances + extrato + carteiras + heads de todas as carteiras para valores antigos. Tudo nesse estado tem assinatura válida, porque um dia foi o estado verdadeiro. Nenhuma verificação interna distingue "o estado de ontem" de "o estado de hoje": só uma **âncora externa** que guarde o estado mais recente. O que já existe:
  - **Comprovante assinado** compartilhado com o vencedor: amarra o head final da cadeia, o nº de lances e o valor. Um rollback de lote liquidado contradiz o comprovante que o vencedor tem em mãos.
  - **WebSocket ao vivo**: cada lance é transmitido (`lot:bid`, com o hash) para todos na sala no momento em que acontece. Quem assistiu tem o hash; um rollback posterior contradiz o que foi transmitido.
  - **Testemunha no navegador**: a página de auditoria guarda em `localStorage` o maior `bidCount`/`headHash` visto por lote e alerta se uma visita posterior mostrar menos lances ou um hash diferente para a mesma sequência.
  - O que o rollback "parcial" (só do lote, como no ataque da revisão) não consegue mais: voltar o lote sem voltar também o extrato e as carteiras, de forma coerente entre si e com todos os outros lotes em que esses licitantes deram lance.
- **Mitigação de produção (não implementada):** publicar periodicamente (ex.: a cada minuto) o head de cada lote e de cada carteira, ou uma raiz Merkle de todos eles, num **log externo append-only**: log de transparência, repositório Git público com commits assinados, serviço de timestamping RFC 3161 ou blockchain pública. O auditor compara o estado atual com o último head publicado; um rollback passa a ser detectável por qualquer pessoa.
- **Quem tiver o `AUDIT_SECRET` e acesso de escrita ao banco consegue forjar uma cadeia inteira válida**: recalcula hashes, assina de novo e atualiza o head. A garantia é contra adulteração por quem tem só o banco (DBA, invasão de banco, backup restaurado errado), não contra o operador que detém a chave.
- A chave pode ir para um KMS/HSM, para que nem o servidor consiga exportá-la (não implementado).
- **Checagem global das carteiras em duas camadas.** A cada auditoria roda uma checagem agregada barata (contagem, último hash, somas e head assinado de todas as carteiras). A cada minuto, um job (`LedgerIntegrityService`) recalcula o hash de **todos** os lançamentos; alterações que não mexem em somas nem contagens, como trocar o `lotId` de um lançamento para "desligar" o pregão apagado de um lote, são detectadas em até um minuto. Se qualquer carteira da plataforma tiver o extrato quebrado, a auditoria de *todos* os lotes acusa `LEDGER_CHAIN_BROKEN` (não dá para saber de qual lote vieram os lançamentos apagados). O resultado do job fica em memória: com várias instâncias, cada uma roda o seu.
- **Dados anteriores a esta versão** (extrato sem encadeamento) não são verificáveis no formato novo: a migration numera os lançamentos antigos mas não consegue assiná-los. Recrie a demonstração com `npm run db:seed`.
- A verificação é por lote. Apagar um **lote inteiro**, com todos os seus lances, não é detectado pela auditoria daquele lote, porque ele deixa de existir. Os comprovantes já emitidos e compartilhados seguem como prova externa.
- A chave depende do `AUDIT_SECRET`: trocar o segredo invalida as assinaturas antigas. Em produção ele é gerado uma única vez pelo Render.

---

## 11. Privacidade

- Em **vitrine, sala, auditoria e comprovante**, licitantes aparecem só como **pseudônimo por lote**, por exemplo `Licitante 7KQ2MX`.
- O pseudônimo é `HMAC-SHA256(AUDIT_SECRET, "alias|lote|usuário")`, codificado em 6 caracteres sem ambiguidade:
  - **estável dentro do lote**: dá para acompanhar a disputa;
  - **diferente entre lotes**: não dá para rastrear a mesma pessoa entre leilões;
  - **irreversível** sem o segredo do servidor.
- Nenhuma resposta pública contém nome, e-mail ou id de licitante. O nome do **leiloeiro** é público, porque ele é o vendedor.
- Na sala, o próprio usuário logado vê os seus lances destacados como "você", porque o servidor informa o pseudônimo dele **naquele lote**.

---

## 12. Testes automatizados

```bash
cd backend
createdb leiloes_test                 # uma vez (banco SEPARADO: os testes apagam tudo)
# aplique o schema no banco de teste:
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/leiloes_test npx prisma migrate deploy
npm test
```

- Os testes usam o banco de `TEST_DATABASE_URL` ou, por padrão, `postgresql://postgres:postgres@localhost:5432/leiloes_test` (veja `backend/test/setup-env.ts`). **Nunca** apontam para o `DATABASE_URL` do `.env`, para não apagar a sua demonstração.
- Para usar outro banco: `TEST_DATABASE_URL=postgresql://user:senha@host:5432/outro_banco npm test`.
- Com Docker: `docker compose exec db createdb -U postgres leiloes_test` e rode os testes no host apontando para `localhost:5432`.

O que é coberto (12 suítes, 156 testes):

| Suíte | Cobre |
|---|---|
| `test/leilao-bids.e2e-spec.ts` | Todas as regras e recusas de lance, ordem de checagem, saldo comprometido, anti-sniping, borda de início e fim |
| `test/leilao-concurrency.e2e-spec.ts` | Rajadas de lances simultâneos no mesmo lote e em lotes diferentes (sem lance perdido, sem saldo negativo, cadeia íntegra) |
| `test/leilao-settlement.e2e-spec.ts` | Liquidação (débito, crédito, comprovante), lote sem lances, idempotência, Minha área |
| `test/leilao-audit.e2e-spec.ts` | Auditoria ÍNTEGRA e detecção de cada ataque (alterar, remover do meio, remover o último, inserir, trocar autor, gênese) |
| `test/leilao-audit-attacks.e2e-spec.ts` | Ataques da revisão: rollback do head (`replay.sql`), rollback parcial, rollback apagando o extrato, `endsAt`/`startsAt` alterados, lance fora da janela, cancelar/descancelar pelo banco, imagem/atributos/dono do lote alterados, saldo alterado, comprovante invalidado |
| `test/core-hardening.e2e-spec.ts` | Teto da carteira (22 depósitos de R$ 1 mi), depósitos concorrentes no teto, saldo do leiloeiro acima de 2³¹, estouro na liquidação isolado por lote, 40 cadastros simultâneos, rate limit (429 após 600 req/min, health fora; login com limite próprio) |
| `test/leilao-realtime.e2e-spec.ts` | Eventos Socket.IO (`lot:state`, `lot:bid`, `user:outbid`, `user:wallet`, `user:won`) |
| `test/leilao-tx-utils.e2e-spec.ts` | Lock e retry das transações |
| `test/seed.e2e-spec.ts` | O seed gera o cenário documentado, **todas as auditorias ÍNTEGRAS**, comprovante válido, carteiras coerentes com o extrato e idempotência |
| `test/unit/audit-crypto.spec.ts` | Determinismo de hashes e assinaturas, verificação com a chave pública, rejeição de adulteração, pseudônimo estável por lote e diferente entre lotes |
| `test/unit/lot-phase.spec.ts` | Fases do lote (bordas inclusivas e exclusivas, cancelado, prorrogado) e lance mínimo |
| `test/unit/core-artworks.service.spec.ts` | API externa: modo live, cache em memória, retry, fallback para o banco, 429, circuit breaker |

O relógio da aplicação é injetável (`Clock`), então os testes "avançam o tempo" para cobrir anti-sniping e liquidação sem esperar.

---

## 13. Deploy

Tudo no plano gratuito: **Supabase** (banco), **Render** (API), **Vercel** (front), **Brevo** (e-mail) e **UptimeRobot** (mantém a API acordada).

### Banco: Supabase

O PostgreSQL free do Render expira em 30 dias, e o Neon free (100 h de computação/mês) não aguenta o job de liquidação consultando o banco a cada 2 s. O Supabase free é uma instância sempre ligada (500 MB), que só pausa após 7 dias **sem** atividade.

1. Em [supabase.com](https://supabase.com): **New project** (anote a senha do banco).
2. **Connect** → **Session pooler** → copie a URI (`postgresql://postgres.<ref>:<senha>@aws-0-<região>.pooler.supabase.com:5432/postgres`).
   - Não use a *Direct connection* (só IPv6, o Render não alcança) nem o *Transaction pooler* (porta 6543, quebra o `prisma migrate deploy`).

### E-mail: Brevo

O Render free bloqueia SMTP nas portas 25, 465 e 587. O Brevo aceita a porta **2525** e envia para qualquer destinatário sem domínio próprio (300 e-mails/dia).

1. Em [brevo.com](https://www.brevo.com): crie a conta e, em **Senders**, verifique o e-mail remetente (pode ser um Gmail).
2. **SMTP & API** → **SMTP**: anote o *login* e gere uma *SMTP key*.

### API: Render (Blueprint)

1. Faça um fork ou push deste repositório no GitHub.
2. No Render: **New → Blueprint** e selecione o repositório. O `render.yaml` cria o web service **casa-de-leiloes-api** (`rootDir: backend`):
   - build: `npm ci --include=dev && npx prisma generate && npm run build`
   - start: `npx prisma migrate deploy && npm run db:seed -- --if-empty && node dist/main.js` (seed só se o banco estiver vazio)
   - health check: `/api/health`
   - `JWT_SECRET` e `AUDIT_SECRET` gerados automaticamente; `SMTP_HOST`/`SMTP_PORT` já apontam para o Brevo.
3. Preencha no painel as variáveis pedidas:
   - `DATABASE_URL`: a URI do Session pooler do Supabase;
   - `DATABASE_CA_CERT`: o conteúdo do certificado do Supabase (*Project Settings → Database → SSL Configuration → Download certificate*; abra o `.crt` no Bloco de Notas e cole tudo, de `-----BEGIN CERTIFICATE-----` a `-----END CERTIFICATE-----`);
   - `SMTP_USER` / `SMTP_PASS`: login e SMTP key do Brevo;
   - `MAIL_FROM`: `Casa de Leilões <seu-remetente-verificado@...>`;
   - `CORS_ORIGIN` e `FRONTEND_URL`: a URL da Vercel (por exemplo, `https://casa-de-leiloes.vercel.app`). Se ainda não tiver, preencha depois do deploy do front e faça um redeploy.
4. Para recriar a demonstração em produção: Shell do serviço → `npm run db:seed`.

### Manter a API acordada: UptimeRobot

Em [uptimerobot.com](https://uptimerobot.com): **New monitor** → HTTP(s) → `https://<sua-api>.onrender.com/api/health` → intervalo de **5 min**. Assim a API não dorme e a liquidação roda no horário. As 750 h/mês do Render free cobrem um serviço ligado 24/7.

### Front: Vercel

1. **New Project** → importe o repositório → **Root Directory: `frontend`** (o framework Next.js é detectado sozinho).
2. Variável de ambiente: `NEXT_PUBLIC_API_URL = https://<sua-api>.onrender.com` (sem `/api`).
3. Deploy. Se a URL da API mudar, refaça o build, porque a variável é embutida no bundle.

### Observações do free tier

- Sem o monitor do UptimeRobot, a API no Render free **dorme após ~15 min sem acesso**. O primeiro acesso depois disso leva de 30 a 60 s. Se a vitrine abrir vazia ou com erro, aguarde e recarregue.
- Enquanto a API dorme, o job de liquidação não roda: lotes que terminaram nesse intervalo são **liquidados assim que ela acorda** (em até ~2 s), com o horário real da liquidação.
- Supabase free: 500 MB de banco, de sobra para a demonstração. O projeto só pausa após 7 dias sem nenhuma consulta. Se pausar, reative-o no painel do Supabase.

---

## 14. Comportamentos inesperados e decisões

- **Cancelamento de lote com lances é permitido**, com **estorno automático** do líder (opcional do enunciado). O lote cancelado sai da vitrine, mas o dono continua vendo no painel, e o histórico **não é apagado**: a auditoria continua acessível e ÍNTEGRA. No lote cancelado, o líder fica vazio, mas o nº de lances, o último preço e o head da cadeia são mantidos.
- Lotes **encerrados não podem ser cancelados** (`CANNOT_CANCEL`).
- **Liquidação não é instantânea:** o job roda a cada 2 s, então o lote pode aparecer "encerrado, aguardando liquidação" por até ~2 s depois do fim (status `AWAITING_SETTLEMENT` em Meus arremates).
- **Anti-sniping usa `agora + 2 min`**, não `fim + 2 min`: um lance nos 2 minutos finais sempre deixa exatamente 2 minutos para resposta. O lote pode ser prorrogado indefinidamente enquanto houver disputa.
- **O líder não pode cobrir o próprio lance** (`ALREADY_WINNING`), mesmo para "subir o teto".
- **O lance precisa caber no saldo disponível inteiro.** Quem já lidera outros lotes tem esse valor comprometido.
- **Depósito é simulado** (de R$ 0,01 a R$ 1.000.000,00 por operação) e não existe saque. O **saldo total** de uma carteira via depósito tem teto de **R$ 10.000.000,00**: um depósito que passaria disso é recusado com `INVALID_DEPOSIT` e mensagem explicando o teto (antes, 22 depósitos de R$ 1 mi estouravam o `INT` do banco e davam 500).
- **Saldo do leiloeiro pode passar de R$ 10 milhões** (ele acumula créditos de arremates; o teto vale para depósitos). Os saldos são `BIGINT` no banco. Se um crédito levasse o saldo além do limite técnico (2⁵³ − 1 centavos, o maior inteiro exato que a API devolve como `number`), a liquidação **daquele lote** é desfeita e logada como erro; o lote fica "encerrado, aguardando liquidação" (o lance do vencedor continua comprometido) até intervenção manual, e os demais lotes seguem sendo liquidados normalmente.
- **Rate limit**: 600 requisições por minuto por IP em toda a API HTTP (exceto `/api/health`). Acima disso, `429 RATE_LIMITED`. É generoso de propósito: só barra scripts em rajada, não uso normal (a sala usa WebSocket, que não conta). Rotas caras ou sensíveis têm limite próprio, menor: login e cadastro, 10/min cada (bcrypt); auditoria e comprovante, 60/min cada (reverificam a cadeia e os extratos).
- **Segredos no Docker Compose**: o `docker-compose.yml` é para demonstração local e sobe sem configuração, com segredos de exemplo **públicos** e `NODE_ENV=development` (a API só avisa no log). Escolhemos isso em vez de `${AUDIT_SECRET:?…}` para manter o "clone e `docker compose up`" do avaliador. Para qualquer ambiente real, defina `JWT_SECRET` e `AUDIT_SECRET` aleatórios e `NODE_ENV=production` num `.env`: aí a API se recusa a subir com segredo ausente, curto ou de exemplo. O Render gera os dois segredos automaticamente.
- O leiloeiro também tem carteira: é nela que entram os créditos dos arremates (`SETTLEMENT_CREDIT`).
- **Início "agora":** um `startsAt` até 5 min no passado é ajustado para o instante atual (formulário preenchido devagar). Mais do que isso é recusado.
- **Imagens vêm do CDN da Art Institute of Chicago.** Se o CDN estiver fora, o front mostra um placeholder. Algumas obras do AIC não têm imagem e são filtradas da busca.
- A **busca do AIC só pagina até 1.000 resultados**, uma limitação da própria API.
- **Free tier hiberna** (ver Deploy): primeiro acesso lento e liquidação atrasada até a API acordar.
- **O seed apaga todos os dados** ao rodar sem `--if-empty`. No Docker, `SEED=true` (padrão) só semeia com o banco vazio.
- O relógio exibido vem do **servidor** (`serverTime`): mesmo com o relógio do computador errado, a contagem regressiva fica certa.
- Ao reconectar o WebSocket (Wi-Fi caiu, aba suspensa), o front entra de novo na sala e recarrega o estado pela API REST, que é a fonte autoritativa.

---

## 15. Uso de IA

Usei IA em todas as etapas do projeto, do código ao deploy, e prefiro deixar claro como.

**Ferramenta:** Claude Code (Anthropic). Em vez de um único assistente fazendo tudo, dividi o trabalho entre **agentes especializados**, cada um com um escopo fechado. As definições estão versionadas em [`.claude/agents/`](.claude/agents/) e podem ser reaproveitadas:

| Agente | Responsável por |
|---|---|
| (orquestração) | Schema Prisma, contrato de API e eventos (`docs/CONTRATO.md`), base da criptografia da auditoria, relógio injetável, gateway WebSocket |
| `backend-core` | Autenticação, carteira, integração resiliente com a API do AIC, lotes e cancelamento |
| `backend-leilao` | Motor de lances com lock, anti-sniping, liquidação, auditoria, comprovantes e testes de concorrência |
| `frontend` | Todas as telas em Next.js, tempo real, verificação no navegador, dark mode |
| `qa-devops` | Seed, Docker Compose, configuração de deploy e este README |
| `revisor` | Revisão independente contra o enunciado, com ataques reais ao banco e rajadas de lances paralelos |

### Como conduzi o processo

1. **Contrato antes do código.** O primeiro passo foi o `docs/CONTRATO.md`, com rotas, tipos, eventos e códigos de erro. Com ele fechado, front e back puderam ser desenvolvidos em paralelo sem divergir.
2. **Regras fixas para todos os agentes.** O [`CLAUDE.md`](CLAUDE.md) define as regras que nenhum agente podia quebrar: dinheiro em centavos, tempo sempre pelo `Clock`, lance e liquidação dentro de transação com `SELECT ... FOR UPDATE`, pseudônimo em tudo que é público.
3. **Revisão por quem não escreveu o código.** Depois da implementação, o agente `revisor`, que não participou da escrita, testou o sistema contra o PDF do enunciado, adulterando o banco e disparando lances simultâneos. Ele encontrou problemas reais: rollback do head da cadeia que passava despercebido, `endsAt` e `cancelledAt` alteráveis direto no banco, estouro de `INT` no depósito, recusas de lance que não apareciam na tela e uma sala que não mudava de fase sozinha. Cada um foi corrigido e virou teste automatizado.
4. **Deploy.** Também usei IA para escolher uma hospedagem gratuita que não cortasse nenhuma funcionalidade (WebSocket, job de liquidação e e-mail) e para resolver os problemas que só apareceram em produção, como a validação TLS do banco no Supabase e o bloqueio de SMTP no plano gratuito do Render.

### O que fiz pessoalmente

- Conduzi os agentes: defini o que cada um faria, revisei as entregas e decidi o que aceitar ou pedir para refazer.
- Testei a aplicação manualmente seguindo o [roteiro da seção 7](#7-roteiro-de-avaliação-passo-a-passo), com duas janelas para simular dois licitantes.
- Fiz o deploy: criei e configurei Supabase, Render, Vercel, Brevo e UptimeRobot e validei tudo em produção.

### Onde não confiei só na IA

As partes críticas (regras de lance, saldo comprometido, liquidação e auditoria) estão cobertas por testes automatizados que rodam contra um PostgreSQL real, incluindo testes de concorrência e de adulteração do banco. Nenhuma mudança entrava se os testes não passassem.
