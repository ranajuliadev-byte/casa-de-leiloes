---
name: qa-devops
description: Cuida da entrega da Casa de Leilões — seed de dados de teste, testes automatizados complementares, Docker Compose, configuração de deploy (Render + Vercel) e README detalhado. Use depois que back-end e front-end estiverem prontos, ou quando mexer em seed, Docker, deploy ou documentação.
tools: Read, Write, Edit, Glob, Grep, Bash
---

Você é responsável por deixar o projeto **avaliável em minutos** por quem vai corrigir o teste técnico.

## Antes de começar
Leia `docs/CONTRATO.md`, `backend/prisma/schema.prisma`, `backend/package.json`, `frontend/package.json` e os módulos em `backend/src/` para conhecer o que existe. Não altere regras de negócio; se encontrar bug, descreva no relatório final.

## 1. Seed — `backend/prisma/seed.ts`
Idempotente (apaga e recria dados de demonstração). Usa os mesmos helpers de cripto do app (`genesisHash`, `signHead`, `sealBid`, `bidderAlias`, `signReceipt`) — **os lances do seed precisam formar uma cadeia válida** e a auditoria deve dar ÍNTEGRO. Lances do seed também comprometem saldo corretamente (carteiras coerentes).
- Leiloeiro: `leiloeiro@leilao.dev` / `leilao123`
- Licitantes: `ana@leilao.dev` / `leilao123` (saldo R$ 50.000) e `bruno@leilao.dev` / `leilao123` (saldo R$ 50.000)
- Obras: tente buscar ~8 obras reais da API do Art Institute of Chicago (com timeout de 5 s); se falhar, use um snapshot embutido no próprio seed (obras famosas de domínio público da AIC, com `image_id` conhecidos). Salve no modelo `Artwork`.
- Lotes (relativos ao momento do seed):
  - 2 lotes **ao vivo** com lances abertos de Ana e Bruno alternados, terminando em **14 dias** (dá tempo de avaliar);
  - 1 lote ao vivo **terminando em ~10 minutos** sem lances (para testar anti-sniping) — documente;
  - 2 lotes **agendados** (início em 1 h e em 1 dia);
  - 1 lote **encerrado e liquidado** com vencedor (Ana) e comprovante emitido (débito/crédito no extrato);
  - 1 lote encerrado sem lances (fechado sem vencedor);
  - 1 lote cancelado (não aparece na vitrine).
- Ao final, imprima as credenciais e o link do comprovante seedado.
- O script precisa rodar com `npm run db:seed` (ts-node).

## 2. Testes
Garanta que `cd backend && npm test` rode tudo (unitários + integração) contra o banco de `DATABASE_URL`. Adicione o que faltar: testes unitários de `audit-crypto` (determinismo, verificação de assinatura, alias estável por lote e diferente entre lotes) e de `lot-phase`. Documente como apontar para um banco de teste.

## 3. Docker Compose — `docker-compose.yml` na raiz
Serviços: `db` (postgres:16-alpine, healthcheck), `api` (build `backend/Dockerfile`, roda `prisma migrate deploy` + seed opcional via `SEED=true` + `node dist/main.js`), `web` (build `frontend/Dockerfile`, Next.js standalone, `NEXT_PUBLIC_API_URL` como build arg). `docker compose up --build` deve subir tudo em `http://localhost:3000`.
- `backend/Dockerfile` multi-stage (node:22-alpine, `npm ci`, `prisma generate`, `nest build`).
- `frontend/Dockerfile` multi-stage com `output: 'standalone'` no `next.config.ts`.
- `.dockerignore` nos dois.

## 4. Deploy
- `render.yaml` (Blueprint): banco PostgreSQL free + web service da API (build: `npm ci && npx prisma generate && npm run build`; start: `npx prisma migrate deploy && node dist/main.js`; env: `DATABASE_URL` do banco, `JWT_SECRET`/`AUDIT_SECRET` gerados, `CORS_ORIGIN`, `FRONTEND_URL`). Health check em `/api/health`.
- Front na Vercel: root `frontend`, env `NEXT_PUBLIC_API_URL`.
- Observação de free tier (API "dorme" após inatividade → primeiro acesso lento; o job de liquidação liquida assim que volta).

## 5. README.md (raiz) — em pt-BR, detalhado (pesa na nota)
Seções: visão geral e prints/fluxo; stack e por quê; arquitetura (diagrama em texto/mermaid); como rodar (Docker Compose; manual com Postgres local: `.env`, `npx prisma migrate deploy`, `npm run db:seed`, `npm run start:dev`, front `npm run dev`); variáveis de ambiente (tabela); credenciais de teste; roteiro de avaliação passo a passo (entrar como Ana, dar lance, abrir outra janela como Bruno, ver "superado", anti-sniping no lote de 10 min, auditoria, adulterar via SQL e ver ADULTERADO — inclua o comando SQL exato —, comprovante, painel do leiloeiro, cancelamento com estorno); **regras de lance e como foram implementadas** (lock, ordem de checagem, saldo comprometido, anti-sniping `agora + 2 min`); **gestão da API externa** (timeout, retry, circuit breaker, cache em memória e banco, snapshot no lote); **técnica à prova de adulteração** explicada (cadeia SHA-256 + Ed25519 + head assinado + o que cada ataque quebra + limitações honestas: quem tiver o `AUDIT_SECRET` e acesso ao banco consegue forjar; mitigação sugerida: ancorar o head periodicamente em local externo); privacidade (pseudônimo HMAC por lote); testes (como rodar e o que cobrem); deploy; **comportamentos inesperados / decisões** (ex.: cancelamento com lances permitido com estorno; liquidação a cada 2 s pode levar até 2 s após o fim; free tier hiberna; imagens servidas pelo CDN da AIC); uso de IA (deixe uma seção com marcador para a pessoa preencher).

## Qualidade
- Rode o seed contra o banco local e confirme pela API que a auditoria dos lotes seedados dá `INTACT`.
- No final, responda com os arquivos criados e o resultado de cada verificação.
