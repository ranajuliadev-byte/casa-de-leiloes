import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '../common/errors';
import { TX_OPTIONS } from '../common/tx-options';
import { JwtPayload } from '../common/auth/auth.guards';
import { normalizeEmail, toUserView, UsersService, UserView } from '../users/users.service';
import { WalletService } from '../wallet/wallet.service';
import type { WalletView } from '../realtime/realtime.gateway';
import { LoginDto, RegisterDto } from './auth.dto';
import { BCRYPT_COST } from './password';

// Hash fixo para comparar quando o e-mail não existe (tempo de resposta parecido nos dois casos).
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_COST);

export interface AuthResponse {
  accessToken: string;
  user: UserView;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly users: UsersService,
    private readonly wallets: WalletService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const email = normalizeEmail(dto.email);
    if (await this.users.findByEmail(email)) throw new AppError('EMAIL_TAKEN');

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    let user: User;
    try {
      // Usuário + carteira na mesma transação: todo usuário tem carteira.
      user = await this.prisma.$transaction(async (tx) => {
        const u = await tx.user.create({ data: { name: dto.name.trim(), email, passwordHash, role: dto.role } });
        await tx.wallet.create({ data: { userId: u.id } });
        return u;
      }, TX_OPTIONS);
    } catch (e) {
      // corrida entre dois cadastros com o mesmo e-mail
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new AppError('EMAIL_TAKEN');
      throw e;
    }
    return this.issue(user);
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const user = await this.users.findByEmail(dto.email);
    const ok = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new AppError('INVALID_CREDENTIALS');
    return this.issue(user);
  }

  async me(userId: string): Promise<{ user: UserView; wallet: WalletView | null }> {
    const user = await this.users.findById(userId);
    if (!user) throw new AppError('UNAUTHORIZED'); // token de usuário removido
    const wallet = await this.wallets.getWalletView(userId);
    return { user: toUserView(user), wallet };
  }

  private issue(user: User): AuthResponse {
    const payload: JwtPayload = { sub: user.id, role: user.role, name: user.name, email: user.email };
    return { accessToken: this.jwt.sign(payload), user: toUserView(user) };
  }
}
