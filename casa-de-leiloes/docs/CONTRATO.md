# Contrato da aplicação — Casa de Leilões

Fonte única de verdade entre back-end e front-end. Qualquer mudança aqui deve ser
refletida nos dois lados. Todos os agentes em `.claude/agents/` seguem este documento.

## Convenções

- **Dinheiro**: sempre inteiro em **centavos** (`...Cents`). R$ 1.250,00 = `125000`. O front formata com `Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })`.
- **Datas**: ISO 8601 UTC (`2026-10-27T23:00:00.000Z`). O front exibe em `America/Sao_Paulo`/local.
- **Prefixo**: toda rota REST começa com `/api`.
- **Auth**: `Authorization: Bearer <accessToken>` (JWT, 7 dias). Papéis: `AUCTIONEER` (leiloeiro) e `BIDDER` (licitante).
- **Erros**: sempre `{ statusCode, code, message, details? }`. `message` já vem em pt-BR. Códigos em `backend/src/common/errors.ts`.
- **Rate limit** (por IP, por minuto): 600 em toda rota HTTP (exceto `/api/health`); 10 em cada rota pública de `/api/auth` (`login`, `register`, `forgot-password`, `reset-password`; `AUTH_RATE_LIMIT`); 30 em `GET /api/artworks/search` (`ARTWORK_SEARCH_RATE_LIMIT`); 60 em `GET /api/audit/lots/:id` e 60 em `GET /api/receipts/:code` (`AUDIT_RATE_LIMIT`). Acima disso: `429 { code: 'RATE_LIMITED' }`.
- **Relógio**: respostas de lote trazem `serverTime`; o front calcula `offset = serverTime - Date.now()` para a contagem regressiva não depender do relógio do usuário.
- **Privacidade**: em vitrine, sala, auditoria e comprovante, licitantes aparecem só como **pseudônimo por lote** (`"Licitante 7KQ2MX"`). Nunca nome/e-mail/id.

## Fases do lote

`SCHEDULED` (agendado) → `LIVE` (ao vivo, aceita lances) → `ENDED` (encerrado). `CANCELLED` nunca aparece na vitrine.
Calculada por `backend/src/common/lot-phase.ts` a partir de `startsAt`, `endsAt`, `cancelledAt`.

## Tipos compartilhados

```ts
type Role = 'AUCTIONEER' | 'BIDDER';
type LotPhase = 'SCHEDULED' | 'LIVE' | 'ENDED' | 'CANCELLED';

interface UserView { id: string; name: string; email: string; role: Role; roles: Role[] } // role = perfil ATIVO (o do token); roles = perfis da conta

interface WalletView { balanceCents: number; committedCents: number; availableCents: number }

interface LedgerEntryView {
  id: string;
  type: 'DEPOSIT' | 'COMMIT' | 'RELEASE' | 'SETTLEMENT_DEBIT' | 'SETTLEMENT_CREDIT';
  amountCents: number;
  lotId: string | null;
  lotTitle: string | null;
  description: string | null;
  createdAt: string;
}

interface ArtworkView {
  id: string;            // "aic:<id>"
  externalId: number;
  title: string;
  artist: string | null;
  dateLabel: string | null;
  medium: string | null;
  dimensions: string | null;
  origin: string | null;
  imageUrl: string | null;  // IIIF 843px
  thumbUrl: string | null;  // IIIF 200px
}

interface LotAttributes {
  artist: string | null; date: string | null; medium: string | null;
  dimensions: string | null; origin: string | null; source: 'aic'; externalId: number | null;
}

interface LotLiveState {            // mesmo objeto do evento WebSocket 'lot:state'
  lotId: string;
  phase: LotPhase;
  currentPriceCents: number | null;
  bidCount: number;
  leaderAlias: string | null;
  minNextBidCents: number;          // próximo lance mínimo aceito
  startsAt: string;
  endsAt: string;                   // fim vigente (já com prorrogações)
  extended: boolean;                // houve prorrogação anti-sniping
  settled: boolean;
  winnerAlias: string | null;
  finalPriceCents: number | null;
  serverTime: string;
}

interface LotSummary extends LotLiveState {   // cards da vitrine
  id: string;
  title: string;
  imageUrl: string | null;
  attributes: LotAttributes;
  startingPriceCents: number;
  minIncrementCents: number;
  originalEndsAt: string;
  auctioneerName: string;           // nome do leiloeiro (público, é o vendedor)
}

interface PublicBid {               // mesmo objeto do evento 'lot:bid'
  id: string; lotId: string; sequence: number; amountCents: number;
  bidderAlias: string; createdAt: string; hash: string;
}

interface LotDetail extends LotSummary {
  description: string | null;
  bids: PublicBid[];                // mais recentes primeiro (até 50)
  viewer: null | {                  // presente quando a requisição tem token
    role: Role;
    alias: string | null;           // pseudônimo do usuário NESTE lote (BIDDER)
    isLeader: boolean;
    myHighestBidCents: number | null;
    position: number | null;        // 1 = líder; posição entre licitantes distintos pelo maior lance de cada um
    canBid: boolean;
    isOwner: boolean;               // leiloeiro dono do lote
  };
}

interface AuctioneerLotView extends LotSummary {
  cancelledAt: string | null;
  cancelReason: string | null;
  result: 'PENDING' | 'SOLD' | 'UNSOLD' | 'CANCELLED';
  receivedCents: number;            // valor creditado (SOLD) ou 0
  canCancel: boolean;
}
```

## REST

### Auth
| Método | Rota | Auth | Corpo | Resposta |
|---|---|---|---|---|
| POST | `/api/auth/register` | — | `{ name, email, password (min 6), role }` | `{ accessToken, user: UserView }` |
| POST | `/api/auth/login` | — | `{ email, password, role? }` | `{ accessToken, user: UserView }` |
| POST | `/api/auth/switch-role` | sim | `{ role }` | `{ accessToken, user: UserView }` |
| POST | `/api/auth/forgot-password` | — | `{ email }` | `{ ok: true, message }` (sempre igual) |
| POST | `/api/auth/reset-password` | — | `{ token, password (min 6) }` | `{ ok: true }` |
| GET | `/api/auth/me` | sim | — | `{ user: UserView, wallet: WalletView \| null }` |

**Dois perfis por conta.** Uma pessoa pode ser leiloeira e compradora com o mesmo e-mail: a conta tem `roles` e o JWT leva o perfil **ativo** (`role`).
- `register` com e-mail novo cria a conta. Com e-mail já cadastrado e a **mesma senha**, habilita o perfil pedido na mesma conta; senha diferente → 409 `EMAIL_TAKEN`; perfil que a conta já tem → 409 `ROLE_ALREADY_ENABLED`.
- `login` com `role`: perfil que a conta não tem → 403 `ROLE_NOT_ENABLED`. Sem `role`, vale o único perfil da conta (conta com os dois → 400 `VALIDATION_ERROR`).
- `switch-role` troca o perfil ativo sem nova senha (só para perfis da conta; o mesmo perfil → 409 `ROLE_ALREADY_ACTIVE`). O token novo **herda a expiração** do atual: trocar de perfil não renova a sessão.
- **Sessão revogável:** o JWT leva `ver` (= `User.tokenVersion`). Toda requisição autenticada (HTTP e WebSocket) confere no banco a versão e se a conta ainda tem o perfil do token; redefinir a senha incrementa a versão e derruba todas as sessões abertas (401).
- Ninguém dá lance nos próprios lotes, mesmo com o perfil de comprador ativo → 403 `CANNOT_BID_OWN_LOT`.

**Recuperação de senha.** `forgot-password` responde sempre igual (não revela se o e-mail existe). Se existir, envia por e-mail o link `FRONTEND_URL/redefinir-senha?token=<43 caracteres base64url>`, de uso único e válido por 30 min; um pedido novo invalida os anteriores, mas só depois de 1 min do último link (pedidos repetidos antes disso não geram nem enviam nada). O link é gerado em segundo plano (o tempo de resposta não depende de a conta existir) e o e-mail não inclui o nome cadastrado. Só o hash SHA-256 do token fica no banco. `reset-password` com token inválido, usado ou expirado → 400 `INVALID_RESET_TOKEN`. A senha vale para os dois perfis.

Todo usuário tem carteira (criada no cadastro). Leiloeiro recebe créditos dos arremates nela.

### Carteira
| GET | `/api/wallet` | sim | — | `{ wallet: WalletView, entries: LedgerEntryView[] }` (50 últimos) |
| POST | `/api/wallet/deposit` | BIDDER | `{ amountCents }` (1 … 100.000.000) | `{ wallet: WalletView }` |

Teto do saldo total da carteira via depósito: **R$ 10.000.000,00** (`1_000_000_000` centavos). Depósito que passaria do teto → 400 `INVALID_DEPOSIT` com `details: { minCents, maxCents, maxBalanceCents, balanceCents }` e mensagem explicando o teto. Saldos são `number` na API (BigInt no banco).

### Obras (API externa — Art Institute of Chicago)
| GET | `/api/artworks/search?q=&page=1` | AUCTIONEER | — | `{ items: ArtworkView[], page, totalPages, source: 'live' \| 'cache', degraded: boolean }` |

Se a API cair/estourar timeout/rate-limit: responde **200** com resultados do cache local (`source: 'cache'`, `degraded: true`). Nunca 500.

### Lotes
| GET | `/api/lots?phase=LIVE\|SCHEDULED\|ENDED&q=&sort=ending\|newest\|price_asc\|price_desc&page=1&pageSize=24` | opcional | — | `{ items: LotSummary[], total, page, pageSize, serverTime }` — nunca inclui CANCELLED |
| GET | `/api/lots/:id` | opcional | — | `LotDetail` (cancelado → 404 `LOT_NOT_FOUND` para público; dono ainda vê) |
| GET | `/api/lots/:id/bids?cursor=&limit=50` | — | — | `{ items: PublicBid[], nextCursor: number \| null }` (cursor = `sequence` do último lance recebido) |
| POST | `/api/lots` | AUCTIONEER | `{ artworkId, startingPriceCents (≥100), minIncrementCents (≥100), startsAt, endsAt, description? }` | `LotDetail` |
| POST | `/api/lots/:id/cancel` | AUCTIONEER dono | `{ reason? }` | `AuctioneerLotView` |
| GET | `/api/auctioneer/lots` | AUCTIONEER | — | `{ items: AuctioneerLotView[], totals: { soldCount, unsoldCount, liveCount, scheduledCount, totalReceivedCents } }` |

Criação: `startsAt` e `endsAt` em ISO 8601 **com fuso** (`Z` ou `±hh:mm`, ex.: `2026-10-28T13:00:00Z`); sem fuso → 400 `VALIDATION_ERROR`. `startsAt` pode ser agora (lote nasce ao vivo; até 5 min no passado é ajustado para agora); `endsAt > startsAt` e `endsAt > agora`. Obra fora do cache com a API externa fora do ar → 503 `EXTERNAL_API_UNAVAILABLE`; obra inexistente → 404 `ARTWORK_NOT_FOUND`. O lote guarda um **snapshot** da obra (título, imagem, atributos) — não depende mais da API externa.

Cancelamento: permitido enquanto o lote está `SCHEDULED` ou `LIVE`. Sem lances → cancela direto. Com lances → **estorno automático**: o valor comprometido do líder volta ao disponível (entrada `RELEASE` no extrato). Encerrados não podem ser cancelados (`CANNOT_CANCEL`).

### Lances
| POST | `/api/lots/:id/bids` | BIDDER | `{ amountCents }` | `{ bid: PublicBid, state: LotLiveState, wallet: WalletView }` |

Recusas (HTTP 4xx, `code`):
- `LOT_NOT_STARTED`, `LOT_ENDED`, `LOT_CANCELLED`
- `BELOW_MINIMUM` → `details: { minimumCents }`
- `INSUFFICIENT_BALANCE` → `details: { availableCents, requiredCents }`
- `ALREADY_WINNING`
- `AUCTIONEER_CANNOT_BID` (perfil ativo de leiloeiro)
- `CANNOT_BID_OWN_LOT` (lote da própria conta)
- `INVALID_AMOUNT`

Ordem de checagem: papel → valor (`INVALID_AMOUNT`) → lote existe (`LOT_NOT_FOUND`) → próprio lote (`CANNOT_BID_OWN_LOT`) → cancelado → fase (não iniciado / encerrado) → já líder → mínimo → saldo.

### Minha área (licitante)
| GET | `/api/me/bids` | BIDDER | — | `{ items: MyLotView[] }` |

```ts
interface MyLotView {
  lot: LotSummary;
  myHighestBidCents: number;
  myBidCount: number;
  alias: string;
  status: 'WINNING' | 'OUTBID' | 'WON' | 'LOST' | 'CANCELLED' | 'AWAITING_SETTLEMENT';
  receipt: null | { code: string; url: string; amountCents: number; issuedAt: string };
}
```

### Auditoria (pública, sem login)
| GET | `/api/audit/public-key` | — | — | `{ algorithm: 'Ed25519', publicKeyPem, publicKeyRawBase64 }` |
| GET | `/api/audit/lots/:id` | — | — | `AuditReport` |

```ts
interface AuditReport {
  lot: {
    id, title, imageUrl, startingPriceCents, minIncrementCents, startsAt, originalEndsAt, endsAt, phase,
    cancelled: boolean, settled: boolean, bidCount, headHash, headSignature, genesisHash,
    cancelledAt: string | null;
    cancelSignature: string | null;       // Ed25519 de cancelPayload
    cancelPayload: string | null;         // ["CANCEL", lotId, cancelledAt, bidCount, headHash] (null se não cancelado)
  };
  genesisPayload: string;                 // texto exato que gera o genesisHash (ver abaixo)
  bids: Array<PublicBid & { prevHash: string; signature: string; payload: string; checks: { hashOk: boolean; linkOk: boolean; signatureOk: boolean; sequenceOk: boolean; aliasOk: boolean } }>; // ordem crescente
  verification: {
    status: 'INTACT' | 'TAMPERED';
    checkedAt: string;
    issues: Array<{ code: string; message: string; sequence?: number }>; // pt-BR
    summary: {
      genesisOk, headOk, chainOk, signaturesOk, countOk, priceOk: boolean;
      timingOk: boolean;                  // lances dentro da janela + endsAt = fim recalculado (anti-sniping)
      cancelOk: boolean;                  // cancelamento (ou ausência dele) com assinatura válida
      ledgerOk: boolean;                  // extrato das carteiras íntegro e 1:1 com os lances
    };
    // Última verificação COMPLETA dos extratos (recalcula o hash de cada lançamento, job a
    // cada 1 min). null = nenhuma desde que a API subiu: só a checagem agregada valeu.
    ledgerCheckedAt: string | null;
  };
  publicKey: { algorithm: 'Ed25519'; publicKeyRawBase64: string };
}
```

`genesisPayload` = JSON de `["GENESIS", lotId, título, descrição, imageUrl, atributos, vendedor, lanceInicial, incremento, startsAt, originalEndsAt]`, em que `atributos` é o objeto `LotAttributes` serializado com **chaves ordenadas recursivamente** e `vendedor` é um HMAC do leiloeiro (32 hex; não revela o id). O navegador só precisa fazer `SHA-256(genesisPayload) === genesisHash`.

Códigos de `issues[].code`:

| Código | Significa |
|---|---|
| `GENESIS_MISMATCH` | título, descrição, imagem, atributos, vendedor, preços ou datas originais alterados |
| `SEQUENCE_GAP` / `LINK_BROKEN` | lance removido/inserido no meio; elo não aponta para o anterior |
| `HASH_MISMATCH` / `BAD_SIGNATURE` / `ALIAS_MISMATCH` | lance alterado; assinatura inválida; autor trocado |
| `AMOUNT_NOT_INCREASING` / `AMOUNT_BELOW_MINIMUM` | sequência de valores fora da regra |
| `BID_OUTSIDE_WINDOW` | lance antes do início, depois do fim vigente naquele momento, fora de ordem no tempo ou depois do cancelamento |
| `END_MISMATCH` | `endsAt` ≠ fim recalculado a partir de `originalEndsAt` + anti-sniping lance a lance |
| `HEAD_SIGNATURE_INVALID` / `HEAD_MISMATCH` / `COUNT_MISMATCH` | topo da cadeia não confere (lances removidos/adicionados no fim) |
| `PRICE_MISMATCH` / `LEADER_MISMATCH` / `RESULT_MISMATCH` | estado do lote (preço, líder, vencedor, liquidação) diverge da cadeia |
| `CANCEL_SIGNATURE_INVALID` | `cancelledAt` sem assinatura válida, ou assinatura sem `cancelledAt` |
| `LEDGER_MISMATCH` | extrato não corresponde 1:1 aos lances (COMMIT por lance, RELEASE "Lance superado" por lance superado, débito/crédito do arremate, estorno do cancelamento) — detecta rollback do lote para um head anterior |
| `LEDGER_CHAIN_BROKEN` | cadeia do extrato de uma carteira quebrada (lançamento apagado/alterado, saldo alterado direto no banco), inclusive em carteiras de fora do lote |

### Comprovante (público)
| GET | `/api/receipts/:code` | — | — | `ReceiptView` |

```ts
interface ReceiptView {
  code: string; url: string;           // url = FRONTEND_URL/comprovante/<code>
  lot: { id, title, imageUrl, attributes: LotAttributes, auctioneerName };
  winnerAlias: string; amountCents: number; bidCount: number;
  chainHead: string; issuedAt: string; signature: string;
  valid: boolean;                      // assinatura + cadeia do lote íntegras
  auditUrl: string;                    // FRONTEND_URL/auditoria/<lotId>
}
```

### Saúde
`GET /api/health` → `{ status: 'ok', serverTime }`

## WebSocket (Socket.IO)

Ver `backend/src/realtime/realtime.gateway.ts`. Conectar em `NEXT_PUBLIC_API_URL` (sem `/api`), `auth: { token }` opcional.

- Cliente emite: `lot:join {lotId}`, `lot:leave {lotId}`, `showcase:join {}`
- Servidor emite: `lot:state` (LotLiveState), `lot:bid` (PublicBid), `user:wallet` (WalletView), `user:outbid` `{lotId,title,newPriceCents,yourAmountCents}`, `user:won` `{lotId,title,amountCents,receiptCode}`

Ao reconectar, o front deve refazer `lot:join` e buscar `GET /api/lots/:id` de novo (estado autoritativo).

## Regras de negócio (resumo)

1. Lance só em lote `LIVE` (`startsAt ≤ agora < endsAt`), avaliado **dentro da transação, com lock**. Ordem de checagem: papel → valor → lote existe → próprio lote → cancelado → fase → já líder → mínimo → saldo.
2. 1º lance ≥ lance inicial; seguintes ≥ lance atual + incremento mínimo.
3. Líder não cobre o próprio lance.
4. Disponível = total − comprometido. Ao liderar, valor fica comprometido; superado → volta ao disponível **na mesma transação**.
5. Anti-sniping: lance aceito com `endsAt − agora ≤ 2 min` → `endsAt = agora + 2 min`.
6. Liquidação (job a cada 2 s + idempotente): debita vencedor (total e comprometido), credita leiloeiro, emite comprovante assinado. Sem lances → fecha sem vencedor.
7. Concorrência: `SELECT … FOR UPDATE` no lote e nas carteiras envolvidas (ordem fixa por id) dentro de `prisma.$transaction`.
8. Cadeia de hashes + assinaturas Ed25519 por lance (ver `backend/src/common/crypto/audit-crypto.ts`). Cancelamento assinado (`cancelSignature`). Extrato encadeado por carteira, com head assinado (nº de lançamentos, último hash, saldo, comprometido) e cada lançamento de lote ligado ao hash do lance (`bidHash`).
9. Teto do saldo via depósito: R$ 10.000.000,00 por carteira.
