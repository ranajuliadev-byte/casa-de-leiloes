import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RegisterForm } from '@/components/auth-forms';
import { PageLoading } from '@/components/ui';

export const metadata: Metadata = { title: 'Criar conta' };

export default function RegisterPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <RegisterForm />
    </Suspense>
  );
}
