'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { CircleCheck, Gavel, Wallet } from 'lucide-react';
import { useAuth } from './auth-provider';
import { Button, Container, Field, InlineError, inputClass } from './ui';
import { apiFetch } from '@/lib/api';
import { homeForRole, ROLE_NAME, roleParam, roleSlug } from '@/lib/roles';
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
  return homeForRole(user.role);
}

/** Query string dos links entre login/cadastro, mantendo o `voltar`. */
function authQs(extra: Record<string, string>, next: string | null) {
  const p = new URLSearchParams(extra);
  if (next) p.set('voltar', next);
  const s = p.toString();
  return s ? `?${s}` : '';
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

const ROLES: { role: Role; title: string; text: string; icon: typeof Gavel }[] = [
  {
    role: 'BIDDER',
    title: ROLE_NAME.BIDDER.title,
    text: 'Deposita saldo na carteira, dá lances nos pregões ao vivo e recebe comprovante quando arremata.',
    icon: Wallet,
  },
  {
    role: 'AUCTIONEER',
    title: ROLE_NAME.AUCTIONEER.title,
    text: 'Escolhe obras do acervo, monta lotes com lance inicial e prazo, acompanha os pregões e recebe os arremates.',
    icon: Gavel,
  },
];

/** Seletor compacto de perfil (login). */
function RolePicker({ value, onChange }: { value: Role; onChange: (r: Role) => void }) {
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-semibold">Entrar como</legend>
      <div className="grid grid-cols-2 gap-2">
        {ROLES.map((r) => {
          const Icon = r.icon;
          const checked = value === r.role;
          return (
            <label
              key={r.role}
              className={clsx(
                'flex cursor-pointer items-center justify-center gap-2 border px-3 py-2.5 text-sm font-semibold transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus',
                checked ? 'border-ink bg-surface text-ink' : 'border-rule-strong text-ink-soft hover:border-ink-soft',
              )}
            >
              <input type="radio" name="perfil" value={r.role} checked={checked} onChange={() => onChange(r.role)} className="sr-only" />
              <Icon className={clsx('h-4 w-4', checked ? 'text-lacre' : 'text-muted')} aria-hidden />
              {r.title}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function LoginForm() {
  const { login, user, loading } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('voltar'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>(() => roleParam(params.get('perfil')) ?? 'BIDDER');
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
      const u = await login(email.trim(), password, role);
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
          <Link href={`/cadastro${authQs({ perfil: roleSlug(role) }, next)}`} className="font-semibold text-ink underline underline-offset-4">
            Criar conta
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-5">
        <RolePicker value={role} onChange={setRole} />
        <Field label="E-mail" htmlFor="email">
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Senha" htmlFor="senha">
          <input id="senha" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
        </Field>
        <Link href="/recuperar-senha" className="-mt-2 self-end text-sm text-ink-soft underline underline-offset-4 hover:text-ink">
          Esqueci minha senha
        </Link>
        <InlineError error={error} />
        <Button type="submit" size="lg" loading={submitting} className="w-full">
          Entrar como {ROLE_NAME[role].one}
        </Button>
      </form>
    </AuthShell>
  );
}

export function RegisterForm() {
  const { register, user, loading } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('voltar'));
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const wantedRole = roleParam(params.get('perfil'));
  const [role, setRole] = useState<Role>(() => wantedRole ?? 'BIDDER');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pwError, setPwError] = useState<string | null>(null);
  // Logado e vindo para cadastrar um perfil que ainda não tem: fica na página (adicionar perfil).
  const addingRole = !!user && !!wantedRole && !user.roles.includes(wantedRole);

  useEffect(() => {
    if (!loading && user && !submitting && !addingRole) router.replace(next ?? homeFor(user));
  }, [loading, user, submitting, addingRole, next, router]);

  useEffect(() => {
    if (addingRole && user) {
      setEmail((v) => v || user.email);
      setName((v) => v || user.name);
    }
  }, [addingRole, user]);

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
      router.replace(next ?? (u.role === 'BIDDER' ? '/carteira' : '/painel/novo'));
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title={addingRole ? `Adicionar perfil de ${ROLE_NAME[role].one}` : 'Criar conta'}
      sub={
        addingRole ? (
          'Confirme com a senha atual da sua conta: os dois perfis ficam na mesma conta.'
        ) : (
          <>
            Já tem conta?{' '}
            <Link href={`/entrar${authQs({ perfil: roleSlug(role) }, next)}`} className="font-semibold text-ink underline underline-offset-4">
              Entrar
            </Link>
          </>
        )
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-5">
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Como você vai usar a Casa</legend>
          <div className="grid gap-3">
            {ROLES.filter((r) => !addingRole || r.role === role).map((r) => {
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
          <p className={clsx('mt-3 text-sm text-muted', addingRole && 'hidden')}>
            Já tem conta no outro perfil? Use o <strong className="font-semibold text-ink-soft">mesmo e-mail e a mesma senha</strong>: os dois perfis ficam
            na mesma conta e você escolhe com qual entrar.
          </p>
        </fieldset>
        <Field label="Nome" htmlFor="nome" hint="Não aparece nos pregões: lá você é identificado por um pseudônimo diferente em cada lote.">
          <input id="nome" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </Field>
        <Field label="E-mail" htmlFor="email">
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
        </Field>
        <Field
          label={addingRole ? 'Senha atual' : 'Senha'}
          htmlFor="senha"
          hint={addingRole ? 'A mesma senha com que você entra hoje.' : 'Pelo menos 6 caracteres.'}
          error={pwError}
        >
          <input
            id="senha"
            type="password"
            autoComplete={addingRole ? 'current-password' : 'new-password'}
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
          {addingRole ? `Adicionar perfil de ${ROLE_NAME[role].one}` : `Criar conta de ${ROLE_NAME[role].one}`}
        </Button>
      </form>
    </AuthShell>
  );
}

/** "Esqueci minha senha": pede o link por e-mail. A resposta não revela se o e-mail existe. */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sentMessage, setSentMessage] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch<{ ok: boolean; message: string }>('/api/auth/forgot-password', {
        method: 'POST',
        body: { email: email.trim() },
        auth: false,
      });
      setSentMessage(res.message);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title="Recuperar senha"
      sub={
        <>
          Lembrou?{' '}
          <Link href="/entrar" className="font-semibold text-ink underline underline-offset-4">
            Entrar
          </Link>
        </>
      }
    >
      {sentMessage ? (
        <div role="status" className="flex gap-3 border border-ok/50 bg-ok-soft p-4 text-sm">
          <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-ok" aria-hidden />
          <div>
            <p className="font-semibold">Verifique seu e-mail</p>
            <p className="mt-1 text-ink-soft">{sentMessage} O link vale por 30 minutos. Confira também a caixa de spam.</p>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-5">
          <p className="text-sm text-muted">Informe o e-mail da sua conta. A nova senha vale para os dois perfis (comprador e leiloeiro).</p>
          <Field label="E-mail" htmlFor="email">
            <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
          </Field>
          <InlineError error={error} />
          <Button type="submit" size="lg" loading={submitting} className="w-full">
            Enviar link de redefinição
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

/** Nova senha a partir do link do e-mail (`?token=`). */
export function ResetPasswordForm() {
  const params = useSearchParams();
  // O token fica no estado e sai da barra de endereço (histórico, captura de tela,
  // compartilhamento de tela) assim que a página abre. Guardado ANTES do replaceState,
  // porque useSearchParams acompanha a URL.
  const [token] = useState(() => params.get('token') ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (window.location.search.includes('token=')) window.history.replaceState(null, '', '/redefinir-senha');
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const pwErr = password.length < 6 ? 'Use pelo menos 6 caracteres.' : null;
    const confirmErr = !pwErr && password !== confirm ? 'As senhas não conferem.' : null;
    setPasswordError(pwErr);
    setConfirmError(confirmErr);
    if (pwErr || confirmErr) return;
    setSubmitting(true);
    try {
      await apiFetch('/api/auth/reset-password', { method: 'POST', body: { token, password }, auth: false });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <AuthShell title="Link incompleto" sub="Este endereço não traz o código de redefinição.">
        <Link href="/recuperar-senha" className="font-semibold underline underline-offset-4">
          Pedir um novo link
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Nova senha" sub="Escolha a nova senha da sua conta. Ela vale para os dois perfis.">
      {done ? (
        <div role="status" className="flex flex-col gap-4">
          <div className="flex gap-3 border border-ok/50 bg-ok-soft p-4 text-sm">
            <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-ok" aria-hidden />
            <p className="font-semibold">Senha alterada. Já pode entrar com a nova senha.</p>
          </div>
          <Link href="/entrar" className="font-semibold underline underline-offset-4">
            Entrar
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-5">
          <Field label="Nova senha" htmlFor="senha" hint="Pelo menos 6 caracteres." error={passwordError}>
            <input
              id="senha"
              type="password"
              autoComplete="new-password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={Boolean(passwordError) || undefined}
              className={inputClass}
            />
          </Field>
          <Field label="Repita a nova senha" htmlFor="confirmar" error={confirmError}>
            <input
              id="confirmar"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={Boolean(confirmError) || undefined}
              className={inputClass}
            />
          </Field>
          <InlineError error={error} />
          <Button type="submit" size="lg" loading={submitting} className="w-full">
            Salvar nova senha
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
