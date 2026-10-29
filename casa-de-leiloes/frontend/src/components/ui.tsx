'use client';

import Link from 'next/link';
import clsx from 'clsx';
import { CircleAlert, ImageOff, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '@/lib/api';
import { friendlyError, type ErrorContext } from '@/lib/errors';

// ---------- botões ----------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function buttonClass(variant: Variant = 'primary', size: 'md' | 'lg' | 'sm' = 'md', extra?: string) {
  return clsx(
    'inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 select-none',
    size === 'lg' && 'h-13 px-6 text-base',
    size === 'md' && 'h-11 px-5 text-sm',
    size === 'sm' && 'h-9 px-3 text-sm',
    variant === 'primary' && 'bg-ink text-paper hover:bg-ink-soft',
    variant === 'secondary' && 'border border-rule-strong bg-surface text-ink hover:border-ink',
    variant === 'ghost' && 'text-ink hover:bg-mat',
    variant === 'danger' && 'bg-lacre text-lacre-ink hover:opacity-90',
    extra,
  );
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  className,
  children,
  disabled,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'md' | 'lg' | 'sm'; loading?: boolean }) {
  return (
    <button className={buttonClass(variant, size, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

// ---------- campos ----------
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  error?: string | null;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-semibold">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-sm text-lacre">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const inputClass =
  'h-11 w-full border border-rule-strong bg-surface px-3 text-base text-ink placeholder:text-muted/70 focus:border-ink focus-visible:outline-2 aria-[invalid=true]:border-lacre';

// ---------- imagem da obra ----------
/**
 * <img> comum (domínio externo/IIIF) com fallback quando a CDN falha.
 * Sempre sobre um passe-partout (`mat`).
 */
export function ArtworkImage({
  src,
  alt,
  className,
  imgClassName,
  fit = 'contain',
  eager,
}: {
  src: string | null | undefined;
  alt: string;
  className?: string;
  imgClassName?: string;
  fit?: 'contain' | 'cover';
  eager?: boolean;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = !src || failedSrc === src;
  return (
    <div className={clsx('mat relative flex items-center justify-center overflow-hidden', className)}>
      {failed ? (
        <div className="flex flex-col items-center gap-2 p-6 text-center text-muted" role="img" aria-label={`Imagem indisponível: ${alt}`}>
          <ImageOff className="h-6 w-6" aria-hidden />
          <span className="display max-w-[16ch] text-sm italic leading-snug">Imagem indisponível no momento</span>
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(src)}
          className={clsx('h-full w-full', fit === 'contain' ? 'object-contain' : 'object-cover', imgClassName)}
        />
      )}
    </div>
  );
}

// ---------- estados ----------
export function Spinner({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 text-muted">
      <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function PageLoading({ label }: { label?: string }) {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <Spinner label={label} />
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  title,
  retrying,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  /** nova tentativa em andamento (gira o botão) */
  retrying?: boolean;
}) {
  const fe = friendlyError(error);
  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-start gap-3 border-l-2 border-lacre py-2 pl-5">
      <p className="display text-2xl">{title ?? fe.title}</p>
      <p className="text-muted">{fe.message}</p>
      <div className="flex flex-wrap gap-3">
        {onRetry && (
          <Button variant="secondary" onClick={onRetry} loading={retrying}>
            Tentar de novo
          </Button>
        )}
        {fe.action && (
          <Link href={fe.action.href} className={buttonClass('primary')}>
            {fe.action.label}
          </Link>
        )}
      </div>
    </div>
  );
}

export function InlineError({ error, id, context }: { error: unknown; id?: string; context?: ErrorContext }) {
  if (!error) return null;
  const fe = friendlyError(error, context);
  const code = error instanceof ApiError && !error.code.startsWith('HTTP_') && error.code !== 'NETWORK_ERROR' ? error.code : null;
  return (
    <div id={id} role="alert" data-error-code={code ?? undefined} className="flex gap-2 border border-lacre/50 bg-lacre-soft p-3 text-sm">
      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-lacre" aria-hidden />
      <div className="min-w-0">
        <p className="font-semibold">{fe.title}</p>
        <p className="text-ink-soft">{fe.message}</p>
        {fe.action && (
          <Link href={fe.action.href} className="mt-1 inline-block font-semibold underline underline-offset-4">
            {fe.action.label}
          </Link>
        )}
        {code && (
          <p className="mt-1 text-xs text-muted">
            Código: <code>{code}</code>
          </p>
        )}
      </div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <p className="display text-2xl">{title}</p>
      {children && <div className="text-muted">{children}</div>}
    </div>
  );
}

export function PageTitle({ children, sub, actions }: { children: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-8 flex flex-col gap-4 border-b border-rule pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="display text-4xl leading-[1.05] sm:text-5xl">{children}</h1>
        {sub && <p className="mt-2 max-w-[60ch] text-muted">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-3">{actions}</div>}
    </div>
  );
}

export function Container({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={clsx('mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8', className)}>{children}</div>;
}
