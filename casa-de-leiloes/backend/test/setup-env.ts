// Executado antes de cada arquivo de teste (jest `setupFiles`): aponta para o banco de TESTE.
// `dotenv/config` (importado por src/main.ts) não sobrescreve variáveis já definidas.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/leiloes_test?schema=public';
process.env.FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:3000';
process.env.AUDIT_SECRET = process.env.AUDIT_SECRET ?? 'segredo-de-auditoria-dos-testes';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'segredo-jwt-dos-testes';
// Os testes criam muitos usuários pelo mesmo IP; o limite de login/cadastro é testado à parte.
process.env.AUTH_RATE_LIMIT = process.env.AUTH_RATE_LIMIT ?? '1000';
