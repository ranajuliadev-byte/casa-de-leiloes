import type { Metadata } from 'next';
import { RequireRole } from '@/components/require-role';
import { MyLotsPage } from '@/components/my-lots-page';

export const metadata: Metadata = { title: 'Meus arremates' };

export default function Page() {
  return (
    <RequireRole role="BIDDER">
      <MyLotsPage />
    </RequireRole>
  );
}
