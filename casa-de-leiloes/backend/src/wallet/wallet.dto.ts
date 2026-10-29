import { IsNumber } from 'class-validator';

export const MIN_DEPOSIT_CENTS = 1;
export const MAX_DEPOSIT_CENTS = 100_000_000; // R$ 1.000.000,00

export class DepositDto {
  // Tipo validado aqui; faixa e inteiro são checados no service para responder INVALID_DEPOSIT.
  @IsNumber({ allowNaN: false, allowInfinity: false })
  amountCents: number;
}
