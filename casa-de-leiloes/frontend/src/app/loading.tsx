import { LoaderCircle } from 'lucide-react';

export default function Loading() {
  return (
    <div role="status" className="flex min-h-[40vh] items-center justify-center gap-2 text-muted">
      <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden />
      <span className="text-sm">Carregando…</span>
    </div>
  );
}
