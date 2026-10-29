'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from './auth-provider';
import { useToast } from './toast';
import { friendlyError } from '@/lib/errors';
import { homeForRole, otherRole, pageRole, ROLE_NAME } from '@/lib/roles';
import type { Role } from '@/lib/types';

/**
 * Troca o perfil ativo (conta com os dois perfis). Só sai da página atual se ela for
 * exclusiva do perfil antigo (ex.: /painel → comprador vai para a vitrine); na sala de um
 * lote, por exemplo, continua no mesmo lugar. Erros aparecem em toast.
 * Devolve null quando a conta não tem o perfil de destino.
 */
export function useRoleSwitch(to?: Role) {
  const { user, switchRole } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  const target = to ?? otherRole(user.role);
  if (target === user.role || !user.roles.includes(target)) return null;
  return {
    target,
    label: `Usar como ${ROLE_NAME[target].one}`,
    busy,
    run: async () => {
      setBusy(true);
      try {
        await switchRole(target);
        const exclusive = pageRole(pathname);
        if (exclusive && exclusive !== target) router.push(homeForRole(target));
      } catch (e) {
        const fe = friendlyError(e);
        push({ tone: 'danger', title: fe.title, message: fe.message });
      } finally {
        setBusy(false);
      }
    },
  };
}
