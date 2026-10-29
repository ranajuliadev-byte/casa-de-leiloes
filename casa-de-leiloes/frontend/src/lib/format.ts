const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const brlNoCents = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

/** 125000 → "R$ 1.250,00" */
export function formatBRL(cents: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '—';
  if (opts.compact && cents % 100 === 0) return brlNoCents.format(cents / 100);
  return brl.format(cents / 100);
}

/** Valor para preencher campo de texto: 125000 → "1.250,00" */
export function centsToInput(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

/**
 * Converte texto digitado em centavos. Aceita "1.250,50", "1250,5", "1250", "R$ 1.250",
 * "1250.50" (ponto decimal só quando há até 2 casas após o último ponto e nenhuma vírgula).
 * Retorna null se inválido.
 */
export function parseBRLToCents(input: string): number | null {
  let s = input.replace(/R\$|\s/g, '').trim();
  if (!s) return null;
  if (!/^[\d.,]+$/.test(s)) return null;
  if (s.includes(',')) {
    const [int, ...rest] = s.split(',');
    if (rest.length > 1) return null;
    const dec = rest[0] ?? '';
    if (dec.length > 2) return null;
    s = `${int.replace(/\./g, '')}.${dec}`;
  } else {
    const parts = s.split('.');
    if (parts.length > 1 && parts[parts.length - 1].length <= 2 && parts.length === 2) {
      // "1250.50" → decimal
    } else {
      s = s.replace(/\./g, '');
    }
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

const TZ = 'America/Sao_Paulo';

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function formatDateShort(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso));
}

export function formatDateLong(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export interface DurationParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export function splitDuration(ms: number): DurationParts {
  const total = Math.max(0, Math.floor(ms / 1000));
  return {
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Duração regressiva: "2d 04:12:09", "04:12:09", "12:09". */
export function formatCountdown(ms: number): string {
  const { days, hours, minutes, seconds } = splitDuration(ms);
  if (days > 0) return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

/** Versão por extenso, para leitores de tela. */
export function describeDuration(ms: number): string {
  const { days, hours, minutes, seconds } = splitDuration(ms);
  const parts: string[] = [];
  if (days) parts.push(`${days} ${days === 1 ? 'dia' : 'dias'}`);
  if (hours) parts.push(`${hours} ${hours === 1 ? 'hora' : 'horas'}`);
  if (minutes) parts.push(`${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`);
  if (!days && !hours) parts.push(`${seconds} ${seconds === 1 ? 'segundo' : 'segundos'}`);
  return parts.join(', ');
}

export function shortHash(hash: string | null | undefined, size = 10): string {
  if (!hash) return '—';
  if (hash.length <= size * 2) return hash;
  return `${hash.slice(0, size)}…${hash.slice(-4)}`;
}

/** Date → valor de <input type="datetime-local"> no fuso local. */
export function toDateTimeLocal(d: Date): string {
  const y = d.getFullYear();
  return `${y}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;
}
