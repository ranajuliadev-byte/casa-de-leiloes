import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Desenvolvimento local ou testes (NODE_ENV ausente, `development` ou `test`). */
export function isLocalEnv(): boolean {
  const env = process.env.NODE_ENV;
  return !env || env === 'development' || env === 'test';
}

/**
 * Envio de e-mail. Com SMTP_HOST configurado, envia via SMTP (SMTP_PORT, SMTP_USER,
 * SMTP_PASS, SMTP_SECURE, MAIL_FROM). Sem SMTP:
 *  - em desenvolvimento/teste, escreve o e-mail no log (para testar o fluxo localmente);
 *  - em qualquer outro ambiente, NÃO loga o conteúdo e só avisa.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private transporter: Transporter | null | undefined;
  /** Últimos e-mails "enviados" sem SMTP (para os testes lerem o link). */
  readonly outbox: MailMessage[] = [];

  private transport(): Transporter | null {
    if (this.transporter !== undefined) return this.transporter;
    const host = process.env.SMTP_HOST;
    this.transporter = host
      ? createTransport({
          host,
          port: Number(process.env.SMTP_PORT) || 587,
          secure: process.env.SMTP_SECURE === 'true',
          auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
        })
      : null;
    return this.transporter;
  }

  async send(msg: MailMessage): Promise<void> {
    const t = this.transport();
    if (t) {
      await t.sendMail({ from: process.env.MAIL_FROM || 'Casa de Leilões <no-reply@casadeleiloes.dev>', ...msg });
      return;
    }
    // O conteúdo (ex.: link de redefinição, que é uma credencial) só vai para o log em
    // desenvolvimento/teste. Qualquer outro ambiente (production, staging...) só avisa.
    if (!isLocalEnv()) {
      this.logger.warn(`SMTP não configurado: e-mail "${msg.subject}" não enviado.`);
      return;
    }
    this.outbox.push(msg);
    if (this.outbox.length > 50) this.outbox.shift();
    this.logger.log(`[sem SMTP] Para: ${msg.to} | ${msg.subject}\n${msg.text}`);
  }
}

@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}
