'use client';

import Link from 'next/link';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import clsx from 'clsx';

export type ToastTone = 'info' | 'success' | 'danger';

export interface ToastInput {
  title: string;
  message?: string;
  tone?: ToastTone;
  href?: string;
  hrefLabel?: string;
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

const ToastContext = createContext<{ push: (t: ToastInput) => void } | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast fora do ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);

  const push = useCallback(
    (t: ToastInput) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      window.setTimeout(() => dismiss(id), t.durationMs ?? 7000);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-relevant="additions"
        className="no-print pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className={clsx(
              'toast-in pointer-events-auto flex w-full max-w-sm gap-3 border bg-surface p-4 shadow-[0_12px_32px_-12px_rgb(0_0_0/0.35)]',
              t.tone === 'danger' ? 'border-lacre' : t.tone === 'success' ? 'border-ok' : 'border-rule-strong',
            )}
          >
            <span
              aria-hidden
              className={clsx(
                'mt-1.5 red-dot',
                t.tone === 'success' && '!bg-ok',
                t.tone === 'info' && '!bg-ink-soft',
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="font-semibold leading-snug">{t.title}</p>
              {t.message && <p className="mt-0.5 text-sm text-muted">{t.message}</p>}
              {t.href && (
                <Link href={t.href} className="mt-2 inline-block text-sm font-semibold underline underline-offset-4" onClick={() => dismiss(t.id)}>
                  {t.hrefLabel ?? 'Abrir'}
                </Link>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="-m-1 h-8 w-8 shrink-0 p-1 text-muted hover:text-ink"
              aria-label="Fechar aviso"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
