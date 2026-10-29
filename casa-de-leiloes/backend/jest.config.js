module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  testEnvironment: 'node',
  testTimeout: 30000,
  // Testes usam o banco de TESTE (TEST_DATABASE_URL ou leiloes_test local).
  setupFiles: ['<rootDir>/test/setup-env.ts'],
};
