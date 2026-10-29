import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ResetPasswordForm } from '@/components/auth-forms';
import { PageLoading } from '@/components/ui';

// O token está na URL: não deixa o endereço vazar como Referer para outros sites.
export const metadata: Metadata = { title: 'Nova senha', referrer: 'no-referrer' };

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ResetPasswordForm />
    </Suspense>
  );
}
