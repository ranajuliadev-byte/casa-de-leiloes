import type { Metadata } from 'next';
import { RequireRole } from '@/components/require-role';
import { NewLotPage } from '@/components/new-lot-page';

export const metadata: Metadata = { title: 'Novo lote' };

export default function Page() {
  return (
    <RequireRole role="AUCTIONEER">
      <NewLotPage />
    </RequireRole>
  );
}
