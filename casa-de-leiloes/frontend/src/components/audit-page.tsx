'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import clsx from 'clsx';
import { ArrowLeft, Check, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { apiFetch, isApiError } from '@/lib/api';
import { useApiResource } from '@/lib/use-api-resource';
import { formatBRL, formatDateLong, formatDateShort, formatTime, shortHash } from '@/lib/format';
import { verifyInBrowser, type BrowserReport } from '@/lib/verify';
import type { AuditReport } from '@/lib/types';
import { compareWitness, recordWitness, type WitnessComparison } from '@/lib/witness';
import { ArtworkImage, Button, Container, ErrorState, PageLoading } from './ui';

function Tick({ ok, label }: { ok: boolean | null; label: string }) {
  if (ok === null)
    return (
      <span className="text-muted" title={`${label}: não verificado`}>
        –<span className="sr-only">{label}: não verificado</span>
      </span>
    );
  return ok ? (
    <span className="inline-flex text-ok" title={`${label}: ok`}>
      <Check className="h-4 w-4" aria-hidden />
      <span className="sr-only">{label}: ok</span>
    </span>
  ) : (
    <span className="inline-flex text-lacre" title={`${label}: falhou`}>
      <X className="h-4 w-4" aria-hidden />
      <span className="sr-only">{label}: falhou</span>
    </span>
  );
}

function Seal({ intact, checkedAt }: { intact: boolean; checkedAt: string }) {
  return (
    <div className={clsx('flex items-center gap-4 border-2 p-4 sm:gap-5 sm:p-6', intact ? 'border-ok text-ok' : 'border-lacre text-lacre')}>
      {intact ? <ShieldCheck className="h-10 w-10 shrink-0 sm:h-14 sm:w-14" aria-hidden strokeWidth={1.5} /> : <ShieldAlert className="h-10 w-10 shrink-0 sm:h-14 sm:w-14" aria-hidden strokeWidth={1.5} />}
      <div>
        <p className="display text-3xl font-semibold leading-none tracking-wide sm:text-5xl">{intact ? 'ÍNTEGRO' : 'ADULTERADO'}</p>
        <p className="mt-2 text-sm text-ink-soft">
          {intact ? 'Nenhum lance foi alterado, inserido ou removido.' : 'O histórico guardado não corresponde ao que foi assinado.'} Verificado pelo servidor em{' '}
          {formatDateShort(checkedAt)}.
        </p>
      </div>
    </div>
  );
}

function BrowserCheck({ report, lotId }: { report: AuditReport; lotId: string }) {
  const [result, setResult] = useState<BrowserReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await verifyInBrowser(report, lotId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <section aria-labelledby="nav-titulo" className="border border-rule-strong p-5 sm:p-6">
      <h2 id="nav-titulo" className="display text-2xl">
        Confira você mesmo
      </h2>
      <p className="mt-1 max-w-[60ch] text-sm text-muted">
        Recalcula cada hash com SHA-256 e confere as assinaturas Ed25519 com a chave pública da Casa, aqui no seu navegador, sem depender do veredito do
        servidor. A chave pública vem na própria resposta: compare-a com a publicada pela Casa em <code className="num">/api/audit/public-key</code>.
      </p>
      <Button className="mt-4" onClick={run} loading={running}>
        Verificar no meu navegador
      </Button>
      <div aria-live="polite" className="mt-4">
        {error && <p className="text-sm text-lacre">{error}</p>}
        {result && (
          <div
            className={clsx(
              'border-l-4 p-4',
              result.ok ? 'border-ok bg-ok-soft' : result.issues.length === 0 ? 'border-warn bg-paper' : 'border-lacre bg-lacre-soft',
            )}
          >
            <p className={clsx('font-semibold', result.ok ? 'text-ok' : result.issues.length === 0 ? 'text-warn' : 'text-lacre')}>
              {result.ok
                ? `Tudo confere: gênese e ${result.bids.length} ${result.bids.length === 1 ? 'lance' : 'lances'} verificados.`
                : result.issues.length === 0
                  ? 'Hashes e encadeamento conferem, mas as assinaturas não puderam ser verificadas aqui.'
                  : 'Encontramos divergências.'}
            </p>
            {!result.ed25519Supported && (
              <p className="mt-1 text-sm">
                Seu navegador não suporta Ed25519 no WebCrypto: conferimos apenas os hashes e o encadeamento. As assinaturas foram checadas só pelo servidor.
              </p>
            )}
            {result.issues.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-sm">
                {result.issues.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {result && <BrowserTable report={report} result={result} />}
    </section>
  );
}

function BrowserTable({ report, result }: { report: AuditReport; result: BrowserReport }) {
  if (!report.bids.length) return null;
  return (
    <details className="relative mt-4 overflow-x-auto text-sm">
      <summary className="cursor-pointer font-semibold">Detalhe da verificação local</summary>
      <table className="num mt-3 w-full text-left">
        <thead className="text-muted">
          <tr>
            <th className="py-1 pr-3 font-normal">#</th>
            <th className="py-1 pr-3 font-normal">Hash</th>
            <th className="py-1 pr-3 font-normal">Elo</th>
            <th className="py-1 pr-3 font-normal">Dados</th>
            <th className="py-1 font-normal">Assinatura</th>
          </tr>
        </thead>
        <tbody>
          {result.bids.map((b) => (
            <tr key={b.sequence} className="border-t border-rule">
              <td className="py-1.5 pr-3">{b.sequence}</td>
              <td className="pr-3"><Tick ok={b.hashOk} label="Hash" /></td>
              <td className="pr-3"><Tick ok={b.linkOk} label="Encadeamento" /></td>
              <td className="pr-3"><Tick ok={b.fieldsOk} label="Dados" /></td>
              <td><Tick ok={b.signatureOk} label="Assinatura" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** Alerta da testemunha local: o histórico atual tem menos lances ou hash diferente do já visto. */
function WitnessAlert({ w }: { w: WitnessComparison }) {
  return (
    <div role="alert" className="flex items-start gap-4 border-2 border-lacre bg-lacre-soft p-4 text-lacre sm:p-5">
      <ShieldAlert className="mt-0.5 h-7 w-7 shrink-0" aria-hidden strokeWidth={1.75} />
      <div className="text-sm">
        <p className="text-base font-semibold">
          Este navegador já viu {w.seenCount} {w.seenCount === 1 ? 'lance' : 'lances'} neste lote
          {w.lastSeenHash ? (
            <>
              {' '}
              (último hash <code className="num">{shortHash(w.lastSeenHash, 12)}</code>)
            </>
          ) : null}
          . O histórico atual tem {w.fewer ? 'menos lances' : ''}
          {w.fewer && w.mismatches.length ? ' e ' : ''}
          {w.mismatches.length ? 'hashes que divergem' : ''} — possível remoção ou reescrita.
        </p>
        {w.mismatches.length > 0 && (
          <ul className="num mt-2 space-y-0.5 text-ink-soft">
            {w.mismatches.slice(0, 5).map((m) => (
              <li key={m.sequence}>
                Lance #{m.sequence}: visto antes como <code>{shortHash(m.seen, 12)}</code>, agora <code>{shortHash(m.now, 12)}</code>
              </li>
            ))}
            {w.mismatches.length > 5 && <li>e mais {w.mismatches.length - 5}.</li>}
          </ul>
        )}
        <p className="mt-2 text-ink-soft">
          Isso vale mesmo que a cadeia atual pareça íntegra: uma cadeia inteira pode ser refeita por quem tem a chave, mas não pode apagar o que outros
          navegadores já testemunharam.
        </p>
      </div>
    </div>
  );
}

export function AuditPage({ lotId }: { lotId: string }) {
  const [witness, setWitness] = useState<WitnessComparison | null>(null);

  const fetchReport = useCallback(
    () => apiFetch<AuditReport>(`/api/audit/lots/${encodeURIComponent(lotId)}`, { auth: false }),
    [lotId],
  );
  const { data: report, error, loading, reload: load } = useApiResource(fetchReport, (r) => {
    // Compara com o que este navegador já viu ANTES de registrar a visita atual.
    setWitness(compareWitness(lotId, r.bids, r.bids.length, true));
    recordWitness(lotId, r.bids, r.bids.length);
  });

  if (!report && error) {
    const nf = isApiError(error) && error.status === 404;
    return (
      <Container className="py-16">
        <ErrorState error={error} title={nf ? 'Lote não encontrado' : undefined} onRetry={nf ? undefined : () => void load()} retrying={loading} />
      </Container>
    );
  }
  if (!report) return <PageLoading label="Conferindo a cadeia de lances…" />;

  const intact = report.verification.status === 'INTACT';
  const s = report.verification.summary;
  const summary: [string, boolean][] = [
    ['Abertura do lote (gênese)', s.genesisOk],
    ['Encadeamento dos lances', s.chainOk],
    ['Assinaturas Ed25519', s.signaturesOk],
    ['Último elo assinado', s.headOk],
    ['Quantidade de lances', s.countOk],
    ['Preço final coerente', s.priceOk],
    ['Horários e prorrogações', s.timingOk],
    ['Cancelamento assinado', s.cancelOk],
    ['Extrato das carteiras', s.ledgerOk],
  ];

  return (
    <Container className="pt-8">
      <Link href={`/lotes/${report.lot.id}`} className="no-print inline-flex items-center gap-2 text-sm text-ink-soft hover:text-ink">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Sala do lote
      </Link>

      <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_auto] lg:items-start">
        <div>
          <p className="text-sm text-muted">Auditoria pública</p>
          <h1 className="display mt-1 text-4xl leading-[1.05] sm:text-5xl">{report.lot.title}</h1>
          <p className="num mt-3 text-sm text-muted">
            {report.lot.bidCount} {report.lot.bidCount === 1 ? 'lance' : 'lances'} · início {formatDateShort(report.lot.startsAt)} · fim {formatDateShort(report.lot.endsAt)}
            {report.lot.cancelled ? ' · cancelado' : ''}
          </p>
        </div>
        <ArtworkImage src={report.lot.imageUrl} alt={report.lot.title} className="hidden aspect-square w-32 p-2 lg:flex" />
      </div>

      <div className="mt-8 flex flex-col gap-4">
        {witness?.alert && <WitnessAlert w={witness} />}
        <Seal intact={intact} checkedAt={report.verification.checkedAt} />
      </div>

      {report.verification.issues.length > 0 && (
        <section aria-labelledby="problemas" className="mt-6">
          <h2 id="problemas" className="font-semibold text-lacre">
            Problemas encontrados
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            {report.verification.issues.map((i, idx) => (
              <li key={`${i.code}-${idx}`}>
                {i.sequence ? <span className="num font-semibold">Lance #{i.sequence}: </span> : null}
                {i.message || 'Problema sem descrição.'}{' '}
                <code className="text-xs text-muted">{i.code}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ul className="mt-6 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {summary.map(([k, ok]) => (
          <li key={k} className="flex items-center gap-2">
            <Tick ok={ok} label={k} />
            {k}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted">
        {report.verification.ledgerCheckedAt
          ? `Verificação completa dos extratos (hash de cada lançamento): ${formatDateShort(report.verification.ledgerCheckedAt)}.`
          : 'A verificação completa dos extratos ainda não rodou desde que o servidor subiu: por enquanto vale a checagem resumida.'}
      </p>

      <section aria-labelledby="cadeia" className="mt-12">
        <h2 id="cadeia" className="display border-b border-ink pb-3 text-2xl">
          Cadeia de lances
        </h2>
        <div className="relative overflow-x-auto">
          <table className="num w-full min-w-[44rem] text-left text-sm">
            <caption className="sr-only">Cada lance com seu hash e o resultado de cada verificação</caption>
            <thead className="text-muted">
              <tr className="border-b border-rule">
                <th scope="col" className="py-2 pr-3 font-normal">#</th>
                <th scope="col" className="py-2 pr-3 font-normal">Licitante</th>
                <th scope="col" className="py-2 pr-3 text-right font-normal">Valor</th>
                <th scope="col" className="py-2 pr-3 font-normal">Horário</th>
                <th scope="col" className="py-2 pr-3 font-normal">Hash</th>
                <th scope="col" className="py-2 pr-2 font-normal" title="Hash confere">Hash</th>
                <th scope="col" className="py-2 pr-2 font-normal" title="Encadeado ao anterior">Elo</th>
                <th scope="col" className="py-2 pr-2 font-normal" title="Assinatura Ed25519">Assin.</th>
                <th scope="col" className="py-2 pr-2 font-normal" title="Sequência">Seq.</th>
                <th scope="col" className="py-2 font-normal" title="Pseudônimo">Pseud.</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-rule text-muted">
                <td className="py-2 pr-3">0</td>
                <td className="pr-3" colSpan={3}>
                  Abertura do lote, lance inicial {formatBRL(report.lot.startingPriceCents)}
                </td>
                <td className="pr-3">
                  <code title={report.lot.genesisHash}>{shortHash(report.lot.genesisHash)}</code>
                </td>
                <td className="pr-2"><Tick ok={s.genesisOk} label="Gênese" /></td>
                <td colSpan={4} />
              </tr>
              {report.bids.map((b) => {
                const bad = !(b.checks.hashOk && b.checks.linkOk && b.checks.signatureOk && b.checks.sequenceOk && b.checks.aliasOk);
                return (
                  <tr key={b.id} className={clsx('border-b border-rule', bad && 'bg-lacre-soft')}>
                    <td className="py-2 pr-3">{b.sequence}</td>
                    <td className="pr-3">{b.bidderAlias}</td>
                    <td className="pr-3 text-right">{formatBRL(b.amountCents)}</td>
                    <td className="pr-3 whitespace-nowrap">{formatTime(b.createdAt)}</td>
                    <td className="pr-3">
                      <code title={b.hash}>{shortHash(b.hash)}</code>
                    </td>
                    <td className="pr-2"><Tick ok={b.checks.hashOk} label="Hash" /></td>
                    <td className="pr-2"><Tick ok={b.checks.linkOk} label="Encadeamento" /></td>
                    <td className="pr-2"><Tick ok={b.checks.signatureOk} label="Assinatura" /></td>
                    <td className="pr-2"><Tick ok={b.checks.sequenceOk} label="Sequência" /></td>
                    <td><Tick ok={b.checks.aliasOk} label="Pseudônimo" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {report.bids.length === 0 && <p className="py-6 text-muted">Este lote não recebeu lances. Só a abertura está registrada.</p>}
        <p className="num mt-3 break-all text-xs text-muted">
          Último elo: <code>{report.lot.headHash}</code>
        </p>
        {report.lot.cancelled && report.lot.cancelSignature !== undefined && (
          <p className="num mt-1 break-all text-xs text-muted">
            Cancelamento assinado:{' '}
            {report.lot.cancelSignature ? <code title={report.lot.cancelSignature}>{shortHash(report.lot.cancelSignature, 24)}</code> : 'sem assinatura registrada'}
          </p>
        )}
      </section>

      <div className="mt-12 grid gap-10 lg:grid-cols-2">
        <section aria-labelledby="como">
          <h2 id="como" className="display text-2xl">
            Como funciona
          </h2>
          <div className="mt-3 space-y-3 text-ink-soft">
            <p>
              Cada lance gera um <strong className="text-ink">hash SHA-256</strong> calculado sobre o seu conteúdo (pseudônimo, valor, horário) e sobre o hash do lance
              anterior. Mudar qualquer lance antigo quebra todos os elos seguintes.
            </p>
            <p>
              A Casa também <strong className="text-ink">assina cada hash com Ed25519</strong>. Sem a chave privada, ninguém, nem quem tenha acesso ao banco de dados,
              consegue reescrever a cadeia com assinaturas válidas. O último elo é assinado junto com a quantidade de lances, então remover lances do fim também é
              detectado.
            </p>
            <p>
              Este navegador também funciona como <strong className="text-ink">testemunha independente</strong>: guarda os hashes dos lances que já viu (aqui e na
              sala ao vivo) e avisa se uma visita futura mostrar menos lances ou hashes diferentes.
            </p>
            <p>Licitantes aparecem só por pseudônimo, diferente em cada lote.</p>
          </div>
        </section>
        <BrowserCheck report={report} lotId={lotId} />
      </div>
      <p className="num mt-8 break-all text-xs text-muted">
        Chave pública Ed25519 (base64): <code>{report.publicKey.publicKeyRawBase64}</code>
        <br />
        Relatório gerado em {formatDateLong(report.verification.checkedAt)}.
      </p>
    </Container>
  );
}
