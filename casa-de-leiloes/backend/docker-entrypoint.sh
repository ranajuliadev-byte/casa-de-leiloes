#!/bin/sh
# Inicialização do container da API:
#   1. aplica as migrations (prisma migrate deploy)
#   2. seed opcional:
#        SEED=true  → semeia só se o banco estiver vazio (não apaga nada num restart)
#        SEED=force → apaga e recria a demonstração a cada subida
#        (outro valor/ausente → não semeia)
#   3. sobe a API
set -e

echo "[entrypoint] Aplicando migrations..."
npx prisma migrate deploy

case "$SEED" in
  true|TRUE|1)
    echo "[entrypoint] Seed (somente se o banco estiver vazio)..."
    node_modules/.bin/ts-node prisma/seed.ts --if-empty || echo "[entrypoint] AVISO: seed falhou; a API sobe mesmo assim."
    ;;
  force|FORCE)
    echo "[entrypoint] Seed forçado (apaga e recria os dados de demonstração)..."
    node_modules/.bin/ts-node prisma/seed.ts || echo "[entrypoint] AVISO: seed falhou; a API sobe mesmo assim."
    ;;
esac

echo "[entrypoint] Iniciando a API na porta ${PORT:-3001}..."
exec node dist/main.js
