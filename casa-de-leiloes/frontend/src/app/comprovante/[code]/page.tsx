import type { Metadata } from 'next';
import { ReceiptPage } from '@/components/receipt-page';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Comprovante de arremate' };

export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <ReceiptPage key={code} code={code} />;
}
