'use client';

import Link from 'next/link';
import { useEffect } from 'react';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="mx-auto flex max-w-xl flex-col items-start px-4 py-24">
      <h1 className="display text-4xl leading-tight">Esta tela não carregou</h1>
      <p className="mt-3 text-muted">Algo inesperado aconteceu ao montar a página. Tente de novo; se persistir, volte à vitrine.</p>
      <div className="mt-8 flex gap-3">
        <button type="button" onClick={reset} className="bg-ink px-5 py-3 text-sm font-semibold text-paper hover:bg-ink-soft">
          Tentar de novo
        </button>
        <Link href="/" className="border border-rule-strong px-5 py-3 text-sm font-semibold hover:border-ink">
          Ir à vitrine
        </Link>
      </div>
    </div>
  );
}
