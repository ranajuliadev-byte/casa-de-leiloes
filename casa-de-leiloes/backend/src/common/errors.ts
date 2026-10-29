import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * Códigos de erro de domínio. O front-end usa `code` para exibir a mensagem
 * certa; `message` já vem em português, pronta para exibir.
 */
export const ErrorCodes = {
  // Lances
  BELOW_MINIMUM: { status: 422, message: 'Lance abaixo do mínimo permitido.' },
  INSUFFICIENT_BALANCE: { status: 422, message: 'Saldo disponível insuficiente para este lance.' },
  ALREADY_WINNING: { status: 409, message: 'Você já está ganhando este lote — não é possível cobrir o próprio lance.' },
  LOT_NOT_STARTED: { status: 409, message: 'Este lote ainda não foi iniciado.' },
  LOT_ENDED: { status: 409, message: 'Este lote já foi encerrado.' },
  LOT_CANCELLED: { status: 409, message: 'Este lote foi cancelado.' },
  AUCTIONEER_CANNOT_BID: { status: 403, message: 'Leiloeiros não podem dar lances.' },
  INVALID_AMOUNT: { status: 400, message: 'Valor inválido.' },
  // Lotes
  LOT_NOT_FOUND: { status: 404, message: 'Lote não encontrado.' },
  NOT_LOT_OWNER: { status: 403, message: 'Você só pode gerenciar os seus próprios lotes.' },
  CANNOT_CANCEL: { status: 409, message: 'Este lote não pode mais ser cancelado.' },
  INVALID_SCHEDULE: { status: 400, message: 'Datas inválidas: o fim deve ser depois do início e no futuro.' },
  ARTWORK_NOT_FOUND: { status: 404, message: 'Obra não encontrada na API nem no cache local.' },
  EXTERNAL_API_UNAVAILABLE: { status: 503, message: 'A API de obras está indisponível no momento. Mostrando apenas resultados em cache.' },
  // Auth / usuários
  EMAIL_TAKEN: { status: 409, message: 'Este e-mail já está cadastrado.' },
  INVALID_CREDENTIALS: { status: 401, message: 'E-mail ou senha inválidos.' },
  UNAUTHORIZED: { status: 401, message: 'Faça login para continuar.' },
  FORBIDDEN_ROLE: { status: 403, message: 'Seu perfil não tem permissão para esta ação.' },
  // Carteira
  INVALID_DEPOSIT: { status: 400, message: 'Valor de depósito inválido.' },
  // Comprovantes / auditoria
  RECEIPT_NOT_FOUND: { status: 404, message: 'Comprovante não encontrado.' },
  // Genérico
  RATE_LIMITED: { status: 429, message: 'Muitas requisições em pouco tempo. Aguarde alguns segundos e tente de novo.' },
  VALIDATION_ERROR: { status: 400, message: 'Dados inválidos.' },
  INTERNAL_ERROR: { status: 500, message: 'Erro interno. Tente novamente.' },
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export class AppError extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    public readonly details?: Record<string, unknown>,
    message?: string,
  ) {
    const def = ErrorCodes[code];
    super({ code, message: message ?? def.message, details }, def.status);
  }
}

/**
 * Formato único de erro da API:
 * { statusCode, code, message, details? }
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    if (!res || typeof res.status !== 'function') return; // contexto ws

    if (exception instanceof AppError) {
      const body = exception.getResponse() as Record<string, unknown>;
      return res.status(exception.getStatus()).json({ statusCode: exception.getStatus(), ...body });
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const r = exception.getResponse() as any;
      const rawMsg = typeof r === 'string' ? r : r?.message;
      const isValidation = status === HttpStatus.BAD_REQUEST && Array.isArray(rawMsg);
      if (status === HttpStatus.TOO_MANY_REQUESTS) {
        return res.status(status).json({ statusCode: status, code: 'RATE_LIMITED', message: ErrorCodes.RATE_LIMITED.message });
      }
      const code =
        status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN_ROLE' : isValidation ? 'VALIDATION_ERROR' : r?.code ?? `HTTP_${status}`;
      return res.status(status).json({
        statusCode: status,
        code,
        message: isValidation
          ? ErrorCodes.VALIDATION_ERROR.message
          : status === 401
            ? ErrorCodes.UNAUTHORIZED.message
            : status === 403
              ? ErrorCodes.FORBIDDEN_ROLE.message
              : rawMsg ?? 'Erro',
        details: isValidation ? { fields: rawMsg } : undefined,
      });
    }

    // Erros 4xx do body-parser que o Nest não converte (413 corpo grande, 415 charset):
    // são culpa do cliente, não falha interna — devolve o status certo e não loga stack.
    const clientStatus = (exception as { status?: unknown; statusCode?: unknown } | null)?.status ?? (exception as any)?.statusCode;
    if (typeof clientStatus === 'number' && clientStatus >= 400 && clientStatus < 500) {
      return res.status(clientStatus).json({
        statusCode: clientStatus,
        code: `HTTP_${clientStatus}`,
        message: clientStatus === 413 ? 'Requisição grande demais.' : 'Requisição inválida.',
      });
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    return res.status(500).json({ statusCode: 500, code: 'INTERNAL_ERROR', message: ErrorCodes.INTERNAL_ERROR.message });
  }
}
