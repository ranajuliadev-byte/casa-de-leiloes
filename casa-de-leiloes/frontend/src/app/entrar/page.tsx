import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginForm } from '@/components/auth-forms';
import { PageLoading } from '@/components/ui';

export const metadata: Metadata = { title: 'Entrar' };

export default function LoginPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <LoginForm />
    </Suspense>
  );
}
