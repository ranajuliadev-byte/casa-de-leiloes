'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Gavel, Wallet } from 'lucide-react';
import { useAuth } from './auth-provider';
import { Button, Container, Field, InlineError, inputClass } from './ui';
import type { Role, UserView } from '@/lib/types';

/**
 * Só caminhos internos. Recusa `//host`, `/\host` (o parser de URL trata `\` como `/`)
 * e caracteres de controle (tab/quebra de linha são descartados pelo parser: `/\t/host`).
 */
function safeNext(v: string | null): string | null {
  if (!v || !v.startsWith('/') || v.startsWith('//')) return null;
  return /[\\\u0000-\u001f]/.test(v) ? null : v;
}

function homeFor(user: UserView) {
  return user.role === 'AUCTIONEER' ? '/painel' : '/';
}

function AuthShell({ title, sub, children }: { title: string; sub: React.ReactNode; children: React.ReactNode }) {
  return (
    <Container className="py-12 sm:py-20">
      <div className="mx-auto max-w-md">
        <h1 className="display text-4xl leading-tight sm:text-5xl">{title}</h1>
        <p className="mt-2 text-muted">{sub}</p>
        <div className="mt-8">{children}</div>
      </div>
    </Container>
  );
}

export function LoginForm() {
  const { login, user, loading } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('voltar'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!loading && user && !submitting) router.replace(next ?? homeFor(user));
  }, [loading, user, submitting, next, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const u = await login(email.trim(), password);
      router.replace(next ?? homeFor(u));
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title="Entrar"
      sub={
        <>
          Ainda não tem conta?{' '}
          <Link href={`/cadastro${next ? `?voltar=${encodeURIComponent(next)}` : ''}`} className="font-semibold text-ink underline underline-offset-4">
            Criar conta
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-5">
        <Field label="E-mail" htmlFor="email">
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Senha" htmlFor="senha">
          <input id="senha" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
        </Field>
        <InlineError error={error} />
        <Button type="submit" size="lg" loading={submitting} className="w-full">
          Entrar
        </Button>
      </form>
    </AuthShell>
  );
}

const ROLES: { role: Role; title: string; text: string; icon: typeof Gavel }[] = [
  {
    role: 'BIDDER',
    title: 'Licitante',
    text: 'Deposita saldo na carteira, dá lances nos pregões ao vivo e recebe comprovante quando arremata.',
    icon: Wallet,
  },
  {
    role: 'AUCTIONEER',
    title: 'Leiloeiro',
    text: 'Escolhe obras do acervo, monta lotes com lance inicial e prazo, acompanha os pregões e recebe os arremates.',
    icon: Gavel,
  },
];

export function RegisterForm() {
  const { register, user, loading } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('voltar'));
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('BIDDER');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pwError, setPwError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user && !submitting) router.replace(next ?? homeFor(user));
  }, [loading, user, submitting, next, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 6) {
      setPwError('Use pelo menos 6 caracteres.');
      return;
    }
    setPwError(null);
    setSubmitting(true);
    try {
      const u = await register({ name: name.trim(), email: email.trim(), password, role });
      router.replace(u.role === 'BIDDER' ? (next ?? '/carteira') : '/painel/novo');
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title="Criar conta"
      sub={
        <>
          Já tem conta?{' '}
          <Link href={`/entrar${next ? `?voltar=${encodeURIComponent(next)}` : ''}`} className="font-semibold text-ink underline underline-offset-4">
            Entrar
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-5">
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Como você vai usar a Casa</legend>
          <div className="grid gap-3">
            {ROLES.map((r) => {
              const Icon = r.icon;
              const checked = role === r.role;
              return (
                <label
                  key={r.role}
                  className={clsx(
                    'flex cursor-pointer gap-4 border p-4 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus',
                    checked ? 'border-ink bg-surface' : 'border-rule-strong hover:border-ink-soft',
                  )}
                >
                  <input type="radio" name="papel" value={r.role} checked={checked} onChange={() => setRole(r.role)} className="sr-only" />
                  <Icon className={clsx('mt-0.5 h-5 w-5 shrink-0', checked ? 'text-lacre' : 'text-muted')} aria-hidden />
                  <span>
                    <span className="flex items-center gap-2 font-semibold">
                      {r.title}
                      {checked && <span className="red-dot" aria-hidden />}
                    </span>
                    <span className="mt-1 block text-sm text-muted">{r.text}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <Field label="Nome" htmlFor="nome" hint="Não aparece nos pregões: lá você é identificado por um pseudônimo diferente em cada lote.">
          <input id="nome" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </Field>
        <Field label="E-mail" htmlFor="email">
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Senha" htmlFor="senha" hint="Pelo menos 6 caracteres." error={pwError}>
          <input
            id="senha"
            type="password"
            autoComplete="new-password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={Boolean(pwError) || undefined}
            className={inputClass}
          />
        </Field>
        <InlineError error={error} />
        <Button type="submit" size="lg" loading={submitting} className="w-full">
          Criar conta de {role === 'BIDDER' ? 'licitante' : 'leiloeiro'}
        </Button>
      </form>
    </AuthShell>
  );
}
