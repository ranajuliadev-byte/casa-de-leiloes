'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from './auth-provider';
import { buttonClass, Container, PageLoading } from './ui';
import type { Role } from '@/lib/types';

/** Protege telas por papel no cliente. A API também valida — isto é só para guiar a pessoa. */
export function RequireRole({ role, children }: { role: Role; children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const pathname = usePathname();

  if (loading) return <PageLoading />;
  if (!user) {
    return (
      <Container className="py-20">
        <div className="mx-auto max-w-md">
          <p className="display text-3xl">Entre para continuar</p>
          <p className="mt-2 text-muted">Esta área é da sua conta de {role === 'BIDDER' ? 'licitante' : 'leiloeiro'}.</p>
          <Link href={`/entrar?voltar=${encodeURIComponent(pathname)}`} className={buttonClass('primary', 'md', 'mt-6')}>
            Entrar
          </Link>
        </div>
      </Container>
    );
  }
  if (user.role !== role) {
    return (
      <Container className="py-20">
        <div className="mx-auto max-w-md">
          <p className="display text-3xl">Área de {role === 'BIDDER' ? 'licitantes' : 'leiloeiros'}</p>
          <p className="mt-2 text-muted">
            Você entrou como {user.role === 'BIDDER' ? 'licitante' : 'leiloeiro'}. Para acessar esta página, use uma conta de{' '}
            {role === 'BIDDER' ? 'licitante' : 'leiloeiro'}.
          </p>
          <Link href={user.role === 'AUCTIONEER' ? '/painel' : '/'} className={buttonClass('secondary', 'md', 'mt-6')}>
            {user.role === 'AUCTIONEER' ? 'Ir ao painel' : 'Ir à vitrine'}
          </Link>
        </div>
      </Container>
    );
  }
  return <>{children}</>;
}
