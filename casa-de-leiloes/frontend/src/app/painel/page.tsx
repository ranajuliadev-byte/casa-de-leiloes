import type { Metadata } from 'next';
import { RequireRole } from '@/components/require-role';
import { PanelPage } from '@/components/panel-page';

export const metadata: Metadata = { title: 'Painel do leiloeiro' };

export default function Page() {
  return (
    <RequireRole role="AUCTIONEER">
      <PanelPage />
    </RequireRole>
  );
}
