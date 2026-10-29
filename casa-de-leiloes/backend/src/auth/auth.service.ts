import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, Role, User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '../common/errors';
import { Clock } from '../common/clock';
import { TX_OPTIONS } from '../common/tx-options';
import { AuthUser, JwtPayload } from '../common/auth/auth.guards';
import { MailService } from '../mail/mail.service';
import { frontendUrl } from '../common/urls';
import { normalizeEmail, toUserView, UsersService, UserView } from '../users/users.service';
import { WalletService } from '../wallet/wallet.service';
import type { WalletView } from '../realtime/realtime.gateway';
import { LoginDto, RegisterDto } from './auth.dto';
import { BCRYPT_COST } from './password';

// Hash fixo para comparar quando o e-mail não existe (tempo de resposta parecido nos dois casos).
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_COST);

/** Validade do link de redefinição de senha. */
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
/** Intervalo mínimo entre dois links de redefinição para a mesma conta. */
export const RESET_COOLDOWN_MS = 60 * 1000;

const ROLE_LABEL: Record<Role, string> = { AUCTIONEER: 'leiloeiro', BIDDER: 'comprador' };

export interface AuthResponse {
  accessToken: string;
  user: UserView;
}

/** Só o hash do token vai para o banco: quem lê o banco não consegue usar o link. */
function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly users: UsersService,
    private readonly wallets: WalletService,
    private readonly clock: Clock,
    private readonly mail: MailService,
  ) {}

  /**
   * Cadastro. E-mail novo: cria a conta com o perfil escolhido. E-mail já cadastrado:
   * com a MESMA senha, habilita o segundo perfil na mesma conta (uma pessoa pode ser
   * leiloeira e compradora); com outra senha, recusa sem revelar mais nada.
   */
  async register(dto: RegisterDto): Promise<AuthResponse> {
    const email = normalizeEmail(dto.email);
    const existing = await this.users.findByEmail(email);
    if (existing) return this.addRole(existing, dto.password, dto.role);

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    let user: User;
    try {
      // Usuário + carteira na mesma transação: todo usuário tem carteira.
      user = await this.prisma.$transaction(async (tx) => {
        const u = await tx.user.create({ data: { name: dto.name.trim(), email, passwordHash, roles: [dto.role] } });
        await tx.wallet.create({ data: { userId: u.id } });
        return u;
      }, TX_OPTIONS);
    } catch (e) {
      // corrida entre dois cadastros com o mesmo e-mail
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new AppError('EMAIL_TAKEN');
      throw e;
    }
    return this.issue(user, dto.role);
  }

  private async addRole(user: User, password: string, role: Role): Promise<AuthResponse> {
    if (!(await bcrypt.compare(password, user.passwordHash))) throw new AppError('EMAIL_TAKEN');
    if (user.roles.includes(role)) throw new AppError('ROLE_ALREADY_ENABLED', { role });
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { roles: [...new Set([...user.roles, role])] },
    });
    return this.issue(updated, role);
  }

  /** Login com o perfil escolhido. Sem `role`, vale o único perfil da conta. */
  async login(dto: LoginDto): Promise<AuthResponse> {
    const user = await this.users.findByEmail(dto.email);
    const ok = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new AppError('INVALID_CREDENTIALS');
    const role = dto.role ?? (user.roles.length === 1 ? user.roles[0] : undefined);
    if (!role) {
      throw new AppError('VALIDATION_ERROR', { fields: ['role'] }, 'Esta conta tem os dois perfis: escolha com qual entrar.');
    }
    if (!user.roles.includes(role)) {
      throw new AppError('ROLE_NOT_ENABLED', { role }, `Esta conta não tem o perfil de ${ROLE_LABEL[role]}. Cadastre-o com o mesmo e-mail e senha.`);
    }
    return this.issue(user, role);
  }

  /**
   * Troca o perfil ativo sem novo login. O token novo herda a expiração do atual:
   * trocar de perfil não pode servir para renovar indefinidamente uma sessão.
   */
  async switchRole(current: AuthUser, role: Role): Promise<AuthResponse> {
    if (role === current.role) throw new AppError('ROLE_ALREADY_ACTIVE', { role });
    const user = await this.users.findById(current.id);
    if (!user) throw new AppError('UNAUTHORIZED');
    if (!user.roles.includes(role)) throw new AppError('ROLE_NOT_ENABLED', { role });
    const remainingSec = current.exp - Math.floor(this.clock.now().getTime() / 1000);
    if (remainingSec <= 0) throw new AppError('UNAUTHORIZED');
    return this.issue(user, role, remainingSec);
  }

  async me(current: AuthUser): Promise<{ user: UserView; wallet: WalletView | null }> {
    const user = await this.users.findById(current.id);
    if (!user) throw new AppError('UNAUTHORIZED'); // token de usuário removido
    const wallet = await this.wallets.getWalletView(current.id);
    return { user: toUserView(user, current.role), wallet };
  }

  /**
   * Pedido de redefinição. A resposta é SEMPRE a mesma e não espera nenhum trabalho
   * ligado à conta (nem banco, nem e-mail): nem o conteúdo nem o tempo revelam se o
   * e-mail existe. O link é gerado em segundo plano (ver issueResetLink).
   */
  async forgotPassword(emailRaw: string): Promise<void> {
    const user = await this.users.findByEmail(emailRaw);
    if (!user) return;
    void this.issueResetLink(user.id).catch((e) =>
      this.logger.error(`Falha ao gerar/enviar o link de redefinição: ${(e as Error)?.message ?? e}`),
    );
  }

  /**
   * Gera um token aleatório de uso único (30 min), guarda só o hash e envia o link.
   * Um link novo invalida os anteriores. Intervalo mínimo entre links por conta
   * (RESET_COOLDOWN_MS): sem ele, qualquer um bombardearia a vítima de e-mails e
   * anularia continuamente o link que ela acabou de receber. A linha do usuário é
   * travada para pedidos simultâneos não deixarem dois links válidos.
   */
  private async issueResetLink(userId: string): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    const user = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      const recent = await tx.passwordResetToken.findFirst({
        where: { userId, usedAt: null, createdAt: { gt: new Date(now.getTime() - RESET_COOLDOWN_MS) } },
        select: { id: true },
      });
      if (recent) return null;
      await tx.passwordResetToken.deleteMany({ where: { userId, usedAt: null } });
      await tx.passwordResetToken.create({
        data: { userId, tokenHash: hashResetToken(token), createdAt: now, expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS) },
      });
      return tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    }, TX_OPTIONS);
    if (!user) return;
    const link = `${frontendUrl()}/redefinir-senha?token=${token}`;
    // Sem o nome da pessoa: ele vem do cadastro (texto livre) e viraria isca de phishing
    // dentro de um e-mail legítimo da Casa.
    await this.mail.send({
      to: user.email,
      subject: 'Redefinição de senha — Casa de Leilões',
      text: `Olá.\n\nPara criar uma nova senha, abra o link abaixo (válido por 30 minutos):\n${link}\n\nSe você não pediu, ignore este e-mail: sua senha continua a mesma.`,
      html: `<p>Olá.</p><p>Para criar uma nova senha, <a href="${link}">clique aqui</a> (válido por 30 minutos).</p><p>Se você não pediu, ignore este e-mail: sua senha continua a mesma.</p>`,
    });
  }

  /**
   * Redefine a senha com um token válido. O token é consumido de forma atômica (uso
   * único) e `tokenVersion` sobe: todas as sessões abertas (inclusive de quem roubou um
   * token) deixam de valer.
   */
  async resetPassword(token: string, password: string): Promise<void> {
    const tokenHash = hashResetToken(token);
    const now = this.clock.now();
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    await this.prisma.$transaction(async (tx) => {
      // Marca como usado SÓ se ainda válido: dois pedidos simultâneos com o mesmo link → um falha.
      const consumed = await tx.passwordResetToken.updateMany({
        where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) throw new AppError('INVALID_RESET_TOKEN');
      const { userId } = await tx.passwordResetToken.findUniqueOrThrow({ where: { tokenHash }, select: { userId: true } });
      await tx.user.update({ where: { id: userId }, data: { passwordHash, tokenVersion: { increment: 1 } } });
      await tx.passwordResetToken.deleteMany({ where: { userId, usedAt: null } });
    }, TX_OPTIONS);
  }

  /** `expiresInSec`: só na troca de perfil (herda o tempo restante do token atual). */
  private issue(user: User, role: Role, expiresInSec?: number): AuthResponse {
    const payload: JwtPayload = { sub: user.id, role, name: user.name, email: user.email, ver: user.tokenVersion };
    const accessToken = expiresInSec ? this.jwt.sign(payload, { expiresIn: expiresInSec }) : this.jwt.sign(payload);
    return { accessToken, user: toUserView(user, role) };
  }
}
