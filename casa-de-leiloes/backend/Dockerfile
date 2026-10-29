# API da Casa de Leilões — NestJS + Prisma (driver adapter pg)
# Build multi-stage: instala e compila no estágio "build"; a imagem final só leva o necessário.

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
# openssl: o Prisma detecta a plataforma (linux-musl-openssl-3.0.x) para baixar o schema-engine do `migrate deploy`
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production \
    PORT=3001 \
    TS_NODE_TRANSPILE_ONLY=true

# node_modules completo: o Prisma CLI (migrate deploy) e o ts-node (seed) são devDependencies.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json package-lock.json tsconfig.json ./
COPY --chown=node:node prisma ./prisma
# o seed reaproveita os helpers de cripto do app (src/common/crypto)
COPY --chown=node:node src ./src
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
