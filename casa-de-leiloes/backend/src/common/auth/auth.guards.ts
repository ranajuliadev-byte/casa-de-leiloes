import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Global,
  Injectable,
  Module,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { AppError } from '../errors';
import { requireSecret } from '../crypto/audit-crypto';
import { PrismaService } from '../../prisma/prisma.service';

/** Usuário autenticado anexado em req.user */
export interface AuthUser {
  id: string;
  /** perfil ATIVO da sessão */
  role: Role;
  name: string;
  email: string;
  /** expiração do token (segundos epoch): a troca de perfil não pode estendê-la */
  exp: number;
}

export interface JwtPayload {
  sub: string;
  role: Role;
  name: string;
  email: string;
  /** User.tokenVersion na emissão; ausente em tokens antigos (= 0) */
  ver?: number;
}

export const JWT_EXPIRES_IN = '7d';

/** Em produção, JWT_SECRET ausente/curto/de exemplo impede a subida (ver requireSecret). */
export function jwtSecret(): string {
  return requireSecret('JWT_SECRET', 'dev-jwt-secret-change-me');
}

function extractToken(req: any): string | null {
  const h: string | undefined = req.headers?.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

/**
 * Sessão a partir do token: assinatura + validade E estado atual da conta no banco.
 * Recusa o token se a conta sumiu, se a senha foi redefinida depois da emissão
 * (`ver` ≠ tokenVersion) ou se a conta não tem mais o perfil ativo do token.
 * Custa uma consulta por chave primária por requisição autenticada.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async resolve(token: string | null | undefined): Promise<AuthUser | null> {
    if (!token) return null;
    let p: JwtPayload & { exp: number };
    try {
      p = this.jwt.verify<JwtPayload & { exp: number }>(token, { secret: jwtSecret() });
    } catch {
      return null;
    }
    const account = await this.prisma.user.findUnique({ where: { id: p.sub }, select: { tokenVersion: true, roles: true } });
    if (!account || account.tokenVersion !== (p.ver ?? 0) || !account.roles.includes(p.role)) return null;
    return { id: p.sub, role: p.role, name: p.name, email: p.email, exp: p.exp };
  }
}

/** Exige login (Authorization: Bearer <token>). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly session: SessionService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const user = await this.session.resolve(extractToken(req));
    if (!user) throw new AppError('UNAUTHORIZED');
    req.user = user;
    return true;
  }
}

/** Login opcional: preenche req.user se houver token válido, sem bloquear. */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly session: SessionService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    req.user = (await this.session.resolve(extractToken(req))) ?? undefined;
    return true;
  }
}

export const ROLES_KEY = 'roles';
/** Use junto com JwtAuthGuard: @UseGuards(JwtAuthGuard, RolesGuard) @Roles('BIDDER') */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!roles || roles.length === 0) return true;
    const user: AuthUser | undefined = ctx.switchToHttp().getRequest().user;
    if (!user) throw new AppError('UNAUTHORIZED');
    if (!roles.includes(user.role)) throw new AppError('FORBIDDEN_ROLE');
    return true;
  }
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser | undefined => {
  return ctx.switchToHttp().getRequest().user;
});

/** Módulo global: JwtService + sessão + guards disponíveis em todos os módulos. */
@Global()
@Module({
  // registerAsync: o segredo é lido na inicialização do app (não no import do arquivo).
  imports: [JwtModule.registerAsync({ useFactory: () => ({ secret: jwtSecret(), signOptions: { expiresIn: JWT_EXPIRES_IN } }) })],
  providers: [SessionService, JwtAuthGuard, OptionalJwtAuthGuard, RolesGuard],
  exports: [JwtModule, SessionService, JwtAuthGuard, OptionalJwtAuthGuard, RolesGuard],
})
export class AuthCommonModule {}
