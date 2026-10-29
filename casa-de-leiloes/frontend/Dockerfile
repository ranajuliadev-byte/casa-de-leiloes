# Front-end da Casa de Leilões — Next.js 15 em modo standalone
# Requer `output: 'standalone'` no next.config.ts.
# NEXT_PUBLIC_API_URL é embutida no bundle no momento do build (é lida pelo NAVEGADOR):
#   docker build --build-arg NEXT_PUBLIC_API_URL=http://localhost:3001 -t casa-web .

# ---------- dependências ----------
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build \
 && (test -f .next/standalone/server.js \
     || (echo "ERRO: .next/standalone não foi gerado. Adicione output: 'standalone' em next.config.ts." && exit 1))

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 3000
CMD ["node", "server.js"]
