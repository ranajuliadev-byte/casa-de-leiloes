'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, Printer, Share2 } from 'lucide-react';
import { buttonClass } from './ui';

export function receiptHref(code: string, url?: string | null): string {
  if (url) return url;
  if (typeof window !== 'undefined') return `${window.location.origin}/comprovante/${code}`;
  return `/comprovante/${code}`;
}

export function ShareButtons({ url, title, text, print, size = 'sm' }: { url: string; title: string; text?: string; print?: boolean; size?: 'sm' | 'md' }) {
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  const copy = async () => {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopyFailed(true);
    }
  };

  const share = async () => {
    try {
      await navigator.share({ title, text, url });
    } catch {
      /* cancelado pela pessoa */
    }
  };

  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <button type="button" onClick={copy} className={buttonClass('secondary', size)}>
        {copied ? <Check className="h-4 w-4 text-ok" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
        {copied ? 'Link copiado' : 'Copiar link'}
      </button>
      {canShare && (
        <button type="button" onClick={share} className={buttonClass('secondary', size)}>
          <Share2 className="h-4 w-4" aria-hidden />
          Compartilhar
        </button>
      )}
      {print && (
        <button type="button" onClick={() => window.print()} className={buttonClass('secondary', size)}>
          <Printer className="h-4 w-4" aria-hidden />
          Imprimir
        </button>
      )}
      <span aria-live="polite" className="sr-only">
        {copied ? 'Link copiado para a área de transferência' : ''}
      </span>
      {copyFailed && (
        <span className="w-full text-sm text-muted">
          Não foi possível copiar automaticamente. Link: <span className="break-all">{url}</span>
        </span>
      )}
    </div>
  );
}
