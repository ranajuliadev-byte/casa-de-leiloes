import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { AppError } from './errors';

function hasNul(v: unknown, depth = 0): boolean {
  if (typeof v === 'string') return v.includes('\u0000');
  if (depth > 8 || v === null || typeof v !== 'object') return false;
  return Object.values(v as Record<string, unknown>).some((x) => hasNul(x, depth + 1));
}

/**
 * Recusa NUL (U+0000) em qualquer entrada (corpo, query, parâmetros). O Postgres não
 * aceita NUL em `text`: sem isto, `?q=%00` virava erro 500 com stack no log, numa rota
 * pública. Roda antes do ValidationPipe.
 */
@Injectable()
export class RejectNulPipe implements PipeTransform {
  transform(value: unknown, meta: ArgumentMetadata) {
    if (meta.type !== 'custom' && hasNul(value)) {
      throw new AppError('VALIDATION_ERROR', { fields: ['caractere inválido (NUL)'] }, 'O texto enviado contém um caractere inválido.');
    }
    return value;
  }
}
