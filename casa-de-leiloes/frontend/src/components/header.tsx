'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { ArrowLeftRight, LogOut, Menu, Moon, Sun, X } from 'lucide-react';
import { useAuth } from './auth-provider';
import { formatBRL } from '@/lib/format';
import { useSocketStatus } from '@/lib/socket';
import { useRoleSwitch } from './use-role-switch';

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === 'dark';
  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      className="flex h-10 w-10 items-center justify-center text-ink-soft hover:text-ink"
      aria-label={dark ? 'Usar tema claro' : 'Usar tema escuro'}
      title={dark ? 'Tema claro' : 'Tema escuro'}
    >
      {mounted ? dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" /> : <span className="h-5 w-5" />}
    </button>
  );
}

function ConnectionDot() {
  const status = useSocketStatus();
  if (status === 'online') return null;
  return (
    <span className="hidden items-center gap-1.5 text-xs text-muted md:inline-flex" role="status">
      <span className={clsx('h-1.5 w-1.5 rounded-full', status === 'offline' ? 'bg-lacre' : 'bg-warn')} aria-hidden />
      {status === 'offline' ? 'Sem tempo real — reconectando' : 'Conectando…'}
    </span>
  );
}

export function Header() {
  const { user, wallet, loading, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const roleSwitch = useRoleSwitch();

  useEffect(() => setOpen(false), [pathname]);

  const links: { href: string; label: string }[] = [{ href: '/', label: 'Vitrine' }];
  if (user?.role === 'AUCTIONEER') links.push({ href: '/painel', label: 'Painel' }, { href: '/painel/novo', label: 'Novo lote' });
  if (user?.role === 'BIDDER') links.push({ href: '/meus-arremates', label: 'Meus arremates' }, { href: '/carteira', label: 'Carteira' });

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname === href || (href !== '/painel' && pathname.startsWith(href + '/')));

  const doLogout = () => {
    logout();
    router.push('/');
  };

  return (
    <header className="no-print sticky top-0 z-40 border-b border-rule bg-paper/92 backdrop-blur supports-[backdrop-filter]:bg-paper/80">
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:bg-ink focus:px-3 focus:py-2 focus:text-paper">
        Pular para o conteúdo
      </a>
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 sm:gap-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex shrink-0 items-baseline gap-2" aria-label="Casa de Leilões — vitrine">
          <span className="red-dot translate-y-[-0.05em]" aria-hidden />
          <span className="display whitespace-nowrap text-lg font-medium leading-none tracking-tight sm:text-[1.35rem]">Casa de Leilões</span>
        </Link>

        <nav aria-label="Principal" className="ml-6 hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={isActive(l.href) ? 'page' : undefined}
              className={clsx(
                'px-3 py-2 text-sm',
                isActive(l.href) ? 'font-semibold text-ink underline decoration-lacre decoration-2 underline-offset-[10px]' : 'text-ink-soft hover:text-ink',
              )}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="-mr-2 ml-auto flex items-center sm:gap-2">
          <ConnectionDot />
          {user?.role === 'BIDDER' && wallet && (
            <Link
              href="/carteira"
              className="num flex flex-col items-end px-1 leading-tight hover:text-ink sm:px-2"
              title="Saldo disponível para lances"
            >
              <span className="text-[11px] text-muted">Disponível</span>
              <span className="text-sm font-semibold">{formatBRL(wallet.availableCents)}</span>
            </Link>
          )}
          <ThemeToggle />
          {!loading && !user && (
            <div className="hidden items-center gap-1 sm:flex">
              <Link href="/entrar" className="px-3 py-2 text-sm font-semibold hover:underline">
                Entrar
              </Link>
              <Link href="/cadastro" className="bg-ink px-4 py-2 text-sm font-semibold text-paper hover:bg-ink-soft">
                Criar conta
              </Link>
            </div>
          )}
          {user && (
            <div className="hidden items-center gap-2 md:flex">
              {roleSwitch && (
                <button
                  type="button"
                  onClick={() => void roleSwitch.run()}
                  disabled={roleSwitch.busy}
                  className="flex items-center gap-1.5 border border-rule-strong px-2.5 py-1.5 text-xs font-semibold text-ink-soft hover:border-ink hover:text-ink disabled:opacity-60"
                  title="Sua conta tem os dois perfis"
                >
                  <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden />
                  {roleSwitch.label}
                </button>
              )}
              <span className="max-w-[12ch] truncate text-sm text-muted" title={user.name}>
                {user.name.split(' ')[0]}
              </span>
              <button type="button" onClick={doLogout} className="flex h-10 w-10 items-center justify-center text-ink-soft hover:text-ink" aria-label="Sair" title="Sair">
                <LogOut className="h-5 w-5" />
              </button>
            </div>
          )}
          <button
            type="button"
            className="flex h-10 w-10 items-center justify-center md:hidden"
            aria-expanded={open}
            aria-controls="menu-movel"
            aria-label={open ? 'Fechar menu' : 'Abrir menu'}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {open && (
        <nav id="menu-movel" aria-label="Menu" className="border-t border-rule bg-paper md:hidden">
          <ul className="mx-auto flex max-w-6xl flex-col px-4 py-2">
            {links.map((l) => (
              <li key={l.href}>
                <Link href={l.href} aria-current={isActive(l.href) ? 'page' : undefined} className={clsx('block py-3 text-base', isActive(l.href) && 'font-semibold')}>
                  {l.label}
                </Link>
              </li>
            ))}
            {!user && !loading && (
              <>
                <li>
                  <Link href="/entrar" className="block py-3 text-base">
                    Entrar
                  </Link>
                </li>
                <li>
                  <Link href="/cadastro" className="block py-3 text-base font-semibold">
                    Criar conta
                  </Link>
                </li>
              </>
            )}
            {roleSwitch && (
              <li>
                <button type="button" onClick={() => void roleSwitch.run()} disabled={roleSwitch.busy} className="flex items-center gap-2 py-3 text-base">
                  <ArrowLeftRight className="h-4 w-4" aria-hidden /> {roleSwitch.label}
                </button>
              </li>
            )}
            {user && (
              <li className="flex items-center justify-between border-t border-rule py-3">
                <span className="text-sm text-muted">{user.name}</span>
                <button type="button" onClick={doLogout} className="flex items-center gap-2 text-sm font-semibold">
                  <LogOut className="h-4 w-4" /> Sair
                </button>
              </li>
            )}
          </ul>
        </nav>
      )}
    </header>
  );
}
