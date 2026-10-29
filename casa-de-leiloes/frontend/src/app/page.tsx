import { Suspense } from 'react';
import { Showcase } from '@/components/showcase';
import { PageLoading } from '@/components/ui';

export default function HomePage() {
  return (
    <Suspense fallback={<PageLoading label="Abrindo a vitrine…" />}>
      <Showcase />
    </Suspense>
  );
}
