/** URL pública do front (links de comprovante, auditoria e e-mails). */
export function frontendUrl(): string {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
}
