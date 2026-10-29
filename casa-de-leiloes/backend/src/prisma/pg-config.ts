/**
 * Configuração do driver `pg` a partir da DATABASE_URL.
 *
 * Bancos como o Supabase assinam o certificado com uma CA própria, que o Node não conhece
 * ("self-signed certificate in certificate chain"). Com DATABASE_CA_CERT (o conteúdo PEM
 * do certificado da CA), a conexão usa TLS validando a cadeia contra essa CA.
 */
export function pgConfig(url = process.env.DATABASE_URL as string, ca = process.env.DATABASE_CA_CERT) {
  if (!ca) return { connectionString: url };
  const parsed = new URL(url);
  // O sslmode da URL sobrescreveria a opção `ssl` abaixo.
  parsed.searchParams.delete('sslmode');
  return { connectionString: parsed.toString(), ssl: { ca: ca.replace(/\\n/g, '\n') } };
}
