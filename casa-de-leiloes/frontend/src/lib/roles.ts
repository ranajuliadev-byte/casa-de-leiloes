import type { Role } from './types';

/** Nomes dos perfis na interface. */
export const ROLE_NAME: Record<Role, { one: string; many: string; title: string }> = {
  BIDDER: { one: 'comprador', many: 'compradores', title: 'Comprador' },
  AUCTIONEER: { one: 'leiloeiro', many: 'leiloeiros', title: 'Leiloeiro' },
};

/** Página inicial de cada perfil. */
export function homeForRole(role: Role): string {
  return role === 'AUCTIONEER' ? '/painel' : '/';
}

/** Páginas que só existem para um perfil (trocar de perfil nelas leva à home do novo). */
export function pageRole(pathname: string): Role | null {
  if (pathname === '/painel' || pathname.startsWith('/painel/')) return 'AUCTIONEER';
  if (pathname === '/carteira' || pathname === '/meus-arremates') return 'BIDDER';
  return null;
}

/** `?perfil=leiloeiro|comprador` na URL → perfil. */
export function roleParam(v: string | null): Role | null {
  return v === 'leiloeiro' ? 'AUCTIONEER' : v === 'comprador' ? 'BIDDER' : null;
}

export function roleSlug(role: Role): string {
  return role === 'AUCTIONEER' ? 'leiloeiro' : 'comprador';
}

export function otherRole(role: Role): Role {
  return role === 'AUCTIONEER' ? 'BIDDER' : 'AUCTIONEER';
}
