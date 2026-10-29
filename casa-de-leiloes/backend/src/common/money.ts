const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** Centavos → "R$ 1.234,56" (mensagens para pessoas; a API sempre trafega centavos). */
export function formatBRL(cents: number): string {
  return BRL.format(cents / 100);
}
