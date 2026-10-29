import type { Metadata } from 'next';
import { RequireRole } from '@/components/require-role';
import { WalletPage } from '@/components/wallet-page';

export const metadata: Metadata = { title: 'Carteira' };

export default function Page() {
  return (
    <RequireRole role="BIDDER">
      <WalletPage />
    </RequireRole>
  );
}
