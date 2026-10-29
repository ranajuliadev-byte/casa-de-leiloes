import { Injectable } from '@nestjs/common';
import { receiptPayload, verifyText } from '../common/crypto/audit-crypto';
import { AppError } from '../common/errors';
import { LotAttributes } from '../common/lot-view';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

export interface ReceiptView {
  code: string;
  url: string;
  lot: { id: string; title: string; imageUrl: string | null; attributes: LotAttributes; auctioneerName: string };
  winnerAlias: string;
  amountCents: number;
  bidCount: number;
  chainHead: string;
  issuedAt: string;
  signature: string;
  valid: boolean;
  auditUrl: string;
}

export function frontendUrl(): string {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

export function receiptUrl(code: string): string {
  return `${frontendUrl()}/comprovante/${encodeURIComponent(code)}`;
}

export function auditUrl(lotId: string): string {
  return `${frontendUrl()}/auditoria/${encodeURIComponent(lotId)}`;
}

@Injectable()
export class ReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Comprovante público: só pseudônimo, nenhum dado pessoal do vencedor. */
  async byCode(code: string): Promise<ReceiptView> {
    if (!code || code.length > 64) throw new AppError('RECEIPT_NOT_FOUND');
    const r = await this.prisma.receipt.findUnique({
      where: { code },
      include: { lot: { include: { auctioneer: { select: { name: true } } } } },
    });
    if (!r) throw new AppError('RECEIPT_NOT_FOUND');

    const signatureOk = verifyText(
      receiptPayload({
        code: r.code,
        lotId: r.lotId,
        winnerAlias: r.winnerAlias,
        amountCents: r.amountCents,
        bidCount: r.bidCount,
        chainHead: r.chainHead,
        issuedAt: r.issuedAt,
      }),
      r.signature,
    );
    const verification = await this.audit.verifyLot(r.lotId);
    // Válido = assinatura do comprovante OK + cadeia do lote íntegra + comprovante
    // coerente com a cadeia (mesmo head, contagem e valor final).
    const valid =
      signatureOk &&
      verification?.status === 'INTACT' &&
      r.lot.headHash === r.chainHead &&
      r.lot.bidCount === r.bidCount &&
      r.lot.finalPriceCents === r.amountCents;

    return {
      code: r.code,
      url: receiptUrl(r.code),
      lot: {
        id: r.lot.id,
        title: r.lot.title,
        imageUrl: r.lot.imageUrl,
        attributes: r.lot.attributes as unknown as LotAttributes,
        auctioneerName: r.lot.auctioneer.name,
      },
      winnerAlias: r.winnerAlias,
      amountCents: r.amountCents,
      bidCount: r.bidCount,
      chainHead: r.chainHead,
      issuedAt: r.issuedAt.toISOString(),
      signature: r.signature,
      valid,
      auditUrl: auditUrl(r.lotId),
    };
  }
}
