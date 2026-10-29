import { Injectable } from '@nestjs/common';
import { Role, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Ver docs/CONTRATO.md → UserView */
export interface UserView {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export function toUserView(u: Pick<User, 'id' | 'name' | 'email' | 'role'>): UserView {
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

/** E-mail é sempre comparado/armazenado em minúsculas e sem espaços. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
  }
}
