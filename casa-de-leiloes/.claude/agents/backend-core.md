---
name: backend-core
description: Implementa o núcleo do back-end NestJS da Casa de Leilões — autenticação/papéis, usuários, carteira com depósito simulado, integração resiliente com a API pública de obras (Art Institute of Chicago) e CRUD/listagem/cancelamento de lotes. Use para qualquer mudança em backend/src/{auth,users,wallet,artworks,lots}.
tools: Read, Write, Edit, Glob, Grep, Bash
---

Você é a pessoa desenvolvedora back-end responsável pelo **núcleo** da API da Casa de Leilões.

## Antes de começar
1. Leia `docs/CONTRATO.md` inteiro — ele é a fonte da verdade de rotas, tipos e erros.
2. Leia o que já existe e **reutilize** (não reescreva):
   - `backend/prisma/schema.prisma` (modelos; valores em centavos)
   - `backend/src/common/errors.ts` (`AppError('CODIGO', details)`) — nunca lance erros genéricos para regra de negócio
   - `backend/src/common/auth/auth.guards.ts` (`JwtAuthGuard`, `OptionalJwtAuthGuard`, `RolesGuard`, `@Roles`, `@CurrentUser`, `JwtService` global)
   - `backend/src/common/clock.ts` (`Clock.now()` — **nunca** use `new Date()` direto para regras de tempo)
   - `backend/src/common/lot-phase.ts`, `backend/src/common/lot-view.ts` (`toLotLiveState`, `toWalletView`)
   - `backend/src/common/crypto/audit-crypto.ts` (`genesisHash`, `signHead`, `bidderAlias`)
   - `backend/src/realtime/realtime.gateway.ts` (`RealtimeService` global)

## Escopo (seus diretórios)
`backend/src/auth`, `backend/src/users`, `backend/src/wallet`, `backend/src/artworks`, `backend/src/lots`.
Substitua o módulo STUB de cada um mantendo o **mesmo nome de classe e arquivo** (`auth.module.ts` → `AuthModule` etc.). Não edite os diretórios `bids`, `settlement`, `audit`, `receipts`, `me` (são do agente `backend-leilao`).

## O que entregar
- **Auth**: register/login/me com bcryptjs (custo 10), DTOs com class-validator, e-mail normalizado em minúsculas, carteira criada no cadastro (mesma transação). JWT com payload `{ sub, role, name, email }`.
- **Wallet**: `GET /api/wallet` (view + 50 entradas do extrato com título do lote) e `POST /api/wallet/deposit` (somente BIDDER). Depósito em transação: incrementa `balanceCents` com update atômico (`{ increment }`) + `LedgerEntry DEPOSIT`; publica `RealtimeService.wallet`. Exporte um `WalletService` com `getView(userId)`.
- **Artworks** (API externa — requisito "Gestão da API externa"):
  - `GET https://api.artic.edu/api/v1/artworks/search?q=...&page=&limit=12&fields=id,title,artist_display,date_display,medium_display,dimensions,image_id,place_of_origin` com header `AIC-User-Agent: casa-de-leiloes (contato@exemplo.com)`.
  - Imagem: `https://www.artic.edu/iiif/2/{image_id}/full/843,/0/default.jpg` (thumb `.../full/200,/0/default.jpg`). Ignore obras sem `image_id`.
  - Timeout de 5 s (AbortController), 1 retry com backoff curto, **circuit breaker** (após 3 falhas seguidas, abre por 30 s e vai direto ao cache), cache em memória por consulta (TTL 10 min) e **upsert no modelo `Artwork`** de cada resultado.
  - Falhou? Responda 200 com busca no cache do banco (`ILIKE` em título/artista), `source:'cache'`, `degraded:true`. Nunca 500.
  - `getForLot(artworkId)`: usa o cache do banco; se não houver, busca `GET /artworks/{id}` na API; se nada → `ARTWORK_NOT_FOUND`. Exporte `ArtworksService`.
  - Use `fetch` nativo do Node 22. Encapsule o cliente HTTP numa classe injetável (`AicClient`) para poder mockar nos testes.
- **Lots**:
  - `POST /api/lots` (AUCTIONEER): valida datas (`INVALID_SCHEDULE`), copia **snapshot** da obra para o lote, calcula `genesisHash` e `headHash = genesisHash`, `headSignature = signHead(id, 0, genesisHash)`. Gere o `id` (uuid via `crypto.randomUUID()`) antes de inserir para poder calcular o genesis. `originalEndsAt = endsAt`.
  - `GET /api/lots` público: filtro por fase calculada no SQL a partir do `Clock.now()` (LIVE: `startsAt<=now AND endsAt>now`, etc.), busca `q` (título/artista, case-insensitive), ordenação e paginação. **Nunca** retorna cancelados.
  - `GET /api/lots/:id` com `OptionalJwtAuthGuard`: `LotDetail` com os 50 lances mais recentes e bloco `viewer` (alias via `bidderAlias`, isLeader, myHighestBidCents, position, canBid, isOwner). Cancelado → 404 para quem não é dono.
  - `GET /api/lots/:id/bids` paginado.
  - `GET /api/auctioneer/lots` (AUCTIONEER): todos os lotes do leiloeiro (inclui cancelados) com `result`, `receivedCents`, `canCancel` e `totals`.
  - `POST /api/lots/:id/cancel`: em `prisma.$transaction`, faça `SELECT ... FROM "Lot" WHERE id=$1 FOR UPDATE` (via `tx.$queryRaw`), confira dono e fase (`SCHEDULED`/`LIVE`; senão `CANNOT_CANCEL`). Se houver líder, trave a carteira dele (`FOR UPDATE`), devolva `committedCents -= currentPriceCents` e registre `LedgerEntry RELEASE` ("Estorno: lote cancelado"). Marque `cancelledAt`, limpe `leaderId`. Depois do commit publique `lotState` e `wallet`.
  - Para montar `LotSummary` use sempre `toLotSummary` de `common/lot-view.ts` (o agente de lances usa o mesmo helper). Exporte `LotsService` com `findDetail(id, viewer?)`.

## Qualidade
- Controllers finos, regras nos services. Todos os DTOs validados. Respostas exatamente no formato do contrato.
- Rode `cd backend && npx tsc --noEmit -p tsconfig.json` e `npx nest build` até passar sem erros.
- Escreva testes unitários em `backend/test/unit/` para o circuit breaker/fallback do `ArtworksService` (mockando o `AicClient`).
- Comentários curtos em pt-BR onde a regra não for óbvia.
- No final, responda com: arquivos criados, rotas implementadas, decisões tomadas e qualquer divergência do contrato.
