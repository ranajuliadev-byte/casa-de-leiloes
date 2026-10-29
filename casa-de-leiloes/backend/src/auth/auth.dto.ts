import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Role } from '@prisma/client';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export const ROLES = Object.values(Role);

export class RegisterDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @Transform(lower)
  @IsEmail()
  @MaxLength(160)
  email: string;

  // bcrypt só considera os primeiros 72 bytes
  @IsString()
  @MinLength(6)
  @MaxLength(72)
  password: string;

  @IsIn(ROLES)
  role: Role;
}

export class LoginDto {
  @Transform(lower)
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(1)
  @MaxLength(72)
  password: string;

  /** Perfil com que a pessoa quer entrar. Omitido: o único perfil da conta (se tiver um só). */
  @IsOptional()
  @IsIn(ROLES)
  role?: Role;
}

export class SwitchRoleDto {
  @IsIn(ROLES)
  role: Role;
}

export class ForgotPasswordDto {
  @Transform(lower)
  @IsEmail()
  @MaxLength(160)
  email: string;
}

export class ResetPasswordDto {
  /** token do link (base64url, 32 bytes) */
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token: string;

  @IsString()
  @MinLength(6)
  @MaxLength(72)
  password: string;
}
