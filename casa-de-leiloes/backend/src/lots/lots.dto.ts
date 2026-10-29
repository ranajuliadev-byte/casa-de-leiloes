import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

const trimOrUndef = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return t === '' ? undefined : t;
};

export const MAX_PRICE_CENTS = 1_000_000_000; // R$ 10 milhões (cabe com folga no Int do Postgres)

/**
 * Data com fuso explícito (`Z` ou `±hh:mm`). Sem ele, `new Date()` lê o valor no fuso do
 * servidor e o lote fica deslocado (ex.: 3 h entre dev em São Paulo e Docker em UTC).
 */
const WITH_TIMEZONE = /(Z|[+-]\d{2}:?\d{2})$/i;
const TIMEZONE_MESSAGE = '$property precisa ter fuso horário (ex.: 2026-10-28T13:00:00Z).';

export class CreateLotDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  artworkId: string; // "aic:<id>" (ou só o número)

  @IsInt()
  @Min(100)
  @Max(MAX_PRICE_CENTS)
  startingPriceCents: number;

  @IsInt()
  @Min(100)
  @Max(MAX_PRICE_CENTS)
  minIncrementCents: number;

  @IsISO8601({ strict: true })
  @Matches(WITH_TIMEZONE, { message: TIMEZONE_MESSAGE })
  startsAt: string;

  @IsISO8601({ strict: true })
  @Matches(WITH_TIMEZONE, { message: TIMEZONE_MESSAGE })
  endsAt: string;

  @IsOptional()
  @Transform(trimOrUndef)
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export class CancelLotDto {
  @IsOptional()
  @Transform(trimOrUndef)
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export const LIST_PHASES = ['LIVE', 'SCHEDULED', 'ENDED'] as const;
export const LIST_SORTS = ['ending', 'newest', 'price_asc', 'price_desc'] as const;

export class ListLotsDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() || undefined : value))
  @IsIn(LIST_PHASES)
  phase?: (typeof LIST_PHASES)[number];

  @IsOptional()
  @Transform(trimOrUndef)
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsIn(LIST_SORTS)
  sort?: (typeof LIST_SORTS)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000) // OFFSET grande é caro e, acima do bigint, vira erro 500
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class ListBidsDto {
  /** `sequence` do último lance da página anterior; devolve lances com sequence menor. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647) // `sequence` é Int no banco
  cursor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
