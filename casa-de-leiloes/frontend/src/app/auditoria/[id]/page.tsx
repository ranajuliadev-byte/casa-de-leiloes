import type { Metadata } from 'next';
import { AuditPage } from '@/components/audit-page';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Auditoria do lote' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AuditPage key={id} lotId={id} />;
}
