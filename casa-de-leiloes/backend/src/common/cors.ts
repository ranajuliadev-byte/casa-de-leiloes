/** Origens liberadas no CORS (HTTP e Socket.IO): `CORS_ORIGIN`, separadas por vírgula. */
export function corsOrigins(): string[] {
  return (process.env.CORS_ORIGIN ?? 'http://localhost:3000').split(',').map((s) => s.trim());
}
