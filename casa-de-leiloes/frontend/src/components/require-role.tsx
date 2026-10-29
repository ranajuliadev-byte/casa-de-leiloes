'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from './auth-provider';
import { Button, buttonClass, Container, InlineError, PageLoading } from './ui';
import { homeForRole, ROLE_NAME, roleSlug } from '@/lib/roles';
import type { Role } from '@/lib/types';

/** Protege telas por papel no cliente. A API também valida — isto é só para guiar a pessoa. */
export function RequireRole({ role, children }: { role: Role; children: React.ReactNode }) {
  const { user, loading, switchRole } = useAuth();
  const pathname = usePathname();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (loading) return <PageLoading />;
  if (!user) {
    return (
      <Container className="py-20">
        <div className="mx-auto max-w-md">
          <p className="display text-3xl">Entre para continuar</p>
          <p className="mt-2 text-muted">Esta área é do perfil de {ROLE_NAME[role].one}.</p>
          <Link href={`/entrar?perfil=${roleSlug(role)}&voltar=${encodeURIComponent(pathname)}`} className={buttonClass('primary', 'md', 'mt-6')}>
            Entrar como {ROLE_NAME[role].one}
          </Link>
        </div>
      </Container>
    );
  }
  if (user.role !== role) {
    const hasRole = user.roles.includes(role);
    const doSwitch = async () => {
      setSwitching(true);
      setError(null);
      try {
        await switchRole(role); // a página re-renderiza com o novo perfil
      } catch (e) {
        setError(e);
      } finally {
        setSwitching(false);
      }
    };
    return (
      <Container className="py-20">
        <div className="mx-auto max-w-md">
          <p className="display text-3xl">Área de {ROLE_NAME[role].many}</p>
          <p className="mt-2 text-muted">
            Você está usando o perfil de {ROLE_NAME[user.role].one}.{' '}
            {hasRole
              ? `Sua conta também tem o perfil de ${ROLE_NAME[role].one}: troque para acessar esta página.`
              : `Para acessar esta página, cadastre o perfil de ${ROLE_NAME[role].one} com o mesmo e-mail e senha.`}
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            {hasRole ? (
              <Button onClick={() => void doSwitch()} loading={switching}>
                Usar como {ROLE_NAME[role].one}
              </Button>
            ) : (
              <Link href={`/cadastro?perfil=${roleSlug(role)}&voltar=${encodeURIComponent(pathname)}`} className={buttonClass('primary')}>
                Cadastrar perfil de {ROLE_NAME[role].one}
              </Link>
            )}
            <Link href={homeForRole(user.role)} className={buttonClass('secondary')}>
              {user.role === 'AUCTIONEER' ? 'Ir ao painel' : 'Ir à vitrine'}
            </Link>
          </div>
          <div className="mt-4">
            <InlineError error={error} />
          </div>
        </div>
      </Container>
    );
  }
  return <>{children}</>;
}
