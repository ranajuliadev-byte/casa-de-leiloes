import { LotRoom } from '@/components/lot-room';

export const dynamic = 'force-dynamic';

export default async function LotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LotRoom key={id} lotId={id} />;
}
