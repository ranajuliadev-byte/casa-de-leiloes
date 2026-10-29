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

/** Usuário autenticado anexado em req.user */
export interface AuthUser {
  id: string;
  role: Role;
  name: string;
  email: string;
}

export interface JwtPayload {
  sub: string;
  role: Role;
  name: string;
  email: string;
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

/** Converte o token em AuthUser (ou null). Usado também pelo gateway WebSocket. */
export function userFromToken(jwt: JwtService, token: string | null | undefined): AuthUser | null {
  if (!token) return null;
  try {
    const p = jwt.verify<JwtPayload>(token, { secret: jwtSecret() });
    return { id: p.sub, role: p.role, name: p.name, email: p.email };
  } catch {
    return null;
  }
}

/** Exige login (Authorization: Bearer <token>). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const user = userFromToken(this.jwt, extractToken(req));
    if (!user) throw new AppError('UNAUTHORIZED');
    req.user = user;
    return true;
  }
}

/** Login opcional: preenche req.user se houver token válido, sem bloquear. */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    req.user = userFromToken(this.jwt, extractToken(req)) ?? undefined;
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

/** Módulo global: JwtService + guards disponíveis em todos os módulos. */
@Global()
@Module({
  // registerAsync: o segredo é lido na inicialização do app (não no import do arquivo).
  imports: [JwtModule.registerAsync({ useFactory: () => ({ secret: jwtSecret(), signOptions: { expiresIn: JWT_EXPIRES_IN } }) })],
  providers: [JwtAuthGuard, OptionalJwtAuthGuard, RolesGuard],
  exports: [JwtModule, JwtAuthGuard, OptionalJwtAuthGuard, RolesGuard],
})
export class AuthCommonModule {}
