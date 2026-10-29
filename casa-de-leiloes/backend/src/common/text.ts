/**
 * Texto que sobrevive igual à ida e volta pelo Postgres. Surrogate UTF-16 isolado
 * (ex.: "\ud800", aceito pelo JSON) vira U+FFFD ao ser gravado, e NUL é recusado pelo
 * tipo `text`. Normalizar ANTES de calcular hashes/assinaturas evita que o valor do
 * banco divirja do valor assinado (o lote nasceria "adulterado").
 */
export function storableText(s: string): string {
  return s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|\u0000/g, '�');
}
