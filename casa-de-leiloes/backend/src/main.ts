import 'dotenv/config';
import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/errors';
import { assertSecretsAtBoot } from './common/crypto/audit-crypto';
import { corsOrigins } from './common/cors';
import { RejectNulPipe } from './common/reject-nul.pipe';
import { isLocalEnv } from './mail/mail.service';

/**
 * Valor do `trust proxy` do Express. Atrás de proxy (Render, Nginx), o IP real vem do
 * X-Forwarded-For, usado pelo rate limit por IP. TRUST_PROXY=<nº de saltos | lista>; no
 * Render, 1 salto; fora disso só proxies locais (`loopback`). NÃO deriva de NODE_ENV: sem
 * proxy na frente, confiar no cabeçalho deixa o cliente forjar um IP novo a cada
 * requisição e burlar todos os rate limits.
 */
export function trustProxySetting(env: NodeJS.ProcessEnv): number | string {
  const v = env.TRUST_PROXY ?? (env.RENDER ? '1' : 'loopback');
  return /^\d+$/.test(v) ? Number(v) : v;
}

export async function configureApp(app: import('@nestjs/common').INestApplication) {
  app.setGlobalPrefix('api');
  const express = app.getHttpAdapter().getInstance?.();
  if (express?.set) express.set('trust proxy', trustProxySetting(process.env));
  // Cabeçalhos de segurança (nosniff, HSTS, frame-ancestors/X-Frame-Options...) e sem X-Powered-By.
  app.use(helmet());
  app.enableCors({
    origin: corsOrigins(),
    credentials: true,
  });
  app.useGlobalPipes(new RejectNulPipe(), new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  return app;
}

async function bootstrap() {
  try {
    assertSecretsAtBoot();
  } catch (e) {
    Logger.error((e as Error).message, 'Bootstrap');
    process.exit(1);
  }
  const app = await NestFactory.create(AppModule);
  await configureApp(app);
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  Logger.log(`API ouvindo em http://localhost:${port}/api`, 'Bootstrap');
  // Fora do ambiente local, configurações que deixam a recuperação de senha quebrada em silêncio.
  if (!isLocalEnv()) {
    if (!process.env.SMTP_HOST) Logger.error('SMTP_HOST não definido: e-mails de recuperação de senha NÃO serão enviados.', 'Bootstrap');
    if (!process.env.FRONTEND_URL) Logger.error('FRONTEND_URL não definido: links em e-mails e comprovantes apontarão para localhost.', 'Bootstrap');
  }
}

if (require.main === module) {
  bootstrap();
}
