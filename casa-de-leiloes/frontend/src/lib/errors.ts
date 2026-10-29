import { ApiError } from './api';
import { formatBRL, formatDateLong } from './format';
import { roleSlug } from './roles';

export interface FriendlyError {
  title: string;
  message: string;
  /** Ação sugerida (ex.: depositar). */
  action?: { label: string; href: string };
  /** Valor sugerido para preencher o campo de lance. */
  suggestedCents?: number;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Contexto opcional para enriquecer a mensagem (ex.: horário de abertura do lote). */
export interface ErrorContext {
  startsAt?: string;
}

/** Mensagem do servidor (já em pt-BR) ou o texto padrão do mesmo motivo. */
function base(err: ApiError, fallback: string): string {
  const m = (err.message ?? '').trim();
  return m || fallback;
}

/** Junta frases garantindo pontuação entre elas. */
function sentences(...parts: (string | null | undefined | false)[]): string {
  return parts
    .filter((p): p is string => Boolean(p && p.trim()))
    .map((p) => {
      const t = p.trim();
      return /[.!?…]$/.test(t) ? t : `${t}.`;
    })
    .join(' ');
}

/**
 * Converte qualquer erro em mensagem pt-BR com base em `code` + `details`.
 * Para as recusas de lance, a base é o `message` do servidor ("Lance abaixo do mínimo…",
 * "Saldo disponível insuficiente…", "Você já está ganhando este lote…",
 * "Este lote ainda não foi iniciado…", "Este lote já foi encerrado…"), enriquecida com `details`.
 */
export function friendlyError(err: unknown, ctx: ErrorContext = {}): FriendlyError {
  if (!(err instanceof ApiError)) {
    return { title: 'Algo deu errado', message: 'Tente novamente em instantes.' };
  }
  const d = err.details ?? {};
  switch (err.code) {
    case 'BELOW_MINIMUM': {
      const min = num(d.minimumCents);
      return {
        title: 'Lance recusado: abaixo do mínimo',
        message: sentences(base(err, 'Lance abaixo do mínimo permitido.'), min !== undefined && `O mínimo agora é ${formatBRL(min)}`),
        suggestedCents: min,
      };
    }
    case 'INSUFFICIENT_BALANCE': {
      const available = num(d.availableCents);
      const required = num(d.requiredCents);
      const parts: string[] = [];
      if (available !== undefined) parts.push(`Você tem ${formatBRL(available)} disponível`);
      if (required !== undefined) parts.push(`este lance precisa de ${formatBRL(required)}`);
      return {
        title: 'Lance recusado: saldo insuficiente',
        message: sentences(base(err, 'Saldo disponível insuficiente para este lance.'), parts.length > 0 && parts.join(' e ')),
        action: { label: 'Depositar na carteira', href: '/carteira' },
      };
    }
    case 'ALREADY_WINNING':
      return {
        title: 'Lance recusado: você já está ganhando',
        message: sentences(
          base(err, 'Você já está ganhando este lote — não é possível cobrir o próprio lance.'),
          'Se alguém cobrir, você poderá dar outro lance',
        ),
      };
    case 'LOT_NOT_STARTED':
      return {
        title: 'Lance recusado: lote ainda não iniciado',
        message: sentences(
          base(err, 'Este lote ainda não foi iniciado.'),
          ctx.startsAt ? `Os lances abrem em ${formatDateLong(ctx.startsAt)}` : 'Os lances abrem no horário de início do lote',
        ),
      };
    case 'LOT_ENDED':
      return {
        title: 'Lance recusado: lote encerrado',
        message: sentences(base(err, 'Este lote já foi encerrado.'), 'Ele não aceita mais lances'),
      };
    case 'LOT_CANCELLED':
      return { title: 'Lote cancelado', message: 'O leiloeiro retirou este lote do pregão.' };
    case 'AUCTIONEER_CANNOT_BID':
      return {
        title: 'Perfil de leiloeiro não dá lances',
        message: 'Se sua conta também tem o perfil de comprador, troque de perfil para dar lances; se não, cadastre-o com o mesmo e-mail e senha.',
        action: { label: 'Cadastrar perfil de comprador', href: '/cadastro?perfil=comprador' },
      };
    case 'CANNOT_BID_OWN_LOT':
      return { title: 'Este lote é seu', message: 'Você não pode dar lances nos lotes que você mesmo colocou em leilão.' };
    case 'EMAIL_TAKEN':
      return { title: 'E-mail já cadastrado', message: err.message, action: { label: 'Esqueci minha senha', href: '/recuperar-senha' } };
    case 'ROLE_ALREADY_ENABLED':
      return { title: 'Você já tem este perfil', message: err.message, action: { label: 'Entrar', href: '/entrar' } };
    case 'ROLE_NOT_ENABLED':
      return {
        title: 'Perfil não habilitado',
        message: err.message,
        action: { label: 'Cadastrar este perfil', href: d.role === 'AUCTIONEER' || d.role === 'BIDDER' ? `/cadastro?perfil=${roleSlug(d.role)}` : '/cadastro' },
      };
    case 'INVALID_RESET_TOKEN':
      return { title: 'Link inválido ou expirado', message: err.message, action: { label: 'Pedir um novo link', href: '/recuperar-senha' } };
    case 'INVALID_AMOUNT':
      return { title: 'Valor inválido', message: 'Digite um valor em reais, por exemplo 1.250,00.' };
    case 'UNAUTHORIZED':
      return { title: 'Entre para continuar', message: 'Sua sessão expirou ou você não entrou.', action: { label: 'Entrar', href: '/entrar' } };
    case 'FORBIDDEN_ROLE':
      return { title: 'Ação não permitida', message: err.message };
    case 'NETWORK_ERROR':
      return { title: 'Sem conexão com o servidor', message: err.message };
    case 'LOT_NOT_FOUND':
      return { title: 'Lote não encontrado', message: 'Ele pode ter sido cancelado ou o endereço está incorreto.' };
    default:
      return { title: 'Não foi possível concluir', message: err.message || 'Tente novamente.' };
  }
}
