import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-start px-4 py-24">
      <p className="num text-sm text-muted">Erro 404</p>
      <h1 className="display mt-2 text-5xl leading-tight">Esta página não está no catálogo</h1>
      <p className="mt-3 text-muted">O endereço pode estar errado, ou o lote foi retirado do pregão.</p>
      <Link href="/" className="mt-8 bg-ink px-5 py-3 text-sm font-semibold text-paper hover:bg-ink-soft">
        Ir à vitrine
      </Link>
    </div>
  );
}
