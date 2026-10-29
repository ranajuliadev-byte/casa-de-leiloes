# Casa de Leilões — guia para o Claude Code

Monorepo do teste técnico Elite Dev (Verzel): casa de leilões online de obras de arte.

- `backend/` — NestJS 11 + Prisma 6 (driver adapter `pg`) + PostgreSQL + Socket.IO
- `frontend/` — Next.js 15 (App Router) + React 19 + Tailwind v4
- `docs/CONTRATO.md` — **contrato** de rotas, tipos, eventos e regras. Leia antes de mexer em qualquer lado.

## Agentes (`.claude/agents/`)
| Agente | Responsável por |
|---|---|
| `backend-core` | auth, usuários, carteira, API externa de obras, lotes |
| `backend-leilao` | lances, tempo real, anti-sniping, liquidação, auditoria, comprovantes, meus arremates |
| `frontend` | todas as telas Next.js |
| `qa-devops` | seed, testes complementares, Docker Compose, deploy, README |
| `revisor` | revisão independente contra o enunciado (somente leitura) |

## Regras do projeto
- Dinheiro sempre em centavos (`Int`). Datas em ISO UTC.
- Regra de tempo usa `Clock.now()` (`backend/src/common/clock.ts`), nunca `new Date()` solto.
- Erros de domínio: `throw new AppError('CODIGO', details)` (`backend/src/common/errors.ts`).
- Lance, cancelamento e liquidação: sempre em `prisma.$transaction` com `SELECT ... FOR UPDATE`.
- Pseudônimo (`bidderAlias`) em tudo que é público. Nunca expor nome/e-mail/id de licitante.
- Mudou o schema? `npx prisma migrate dev --name <nome>` e atualize `docs/CONTRATO.md` se afetar a API.

## Comandos
```bash
cd backend && npm run start:dev      # API em :3001
cd backend && npm test               # testes (usa DATABASE_URL)
cd backend && npm run db:seed        # dados de demonstração
cd frontend && npm run dev           # front em :3000
docker compose up --build            # tudo junto
```
