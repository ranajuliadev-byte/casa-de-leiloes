import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AUTH_RATE_LIMIT, PASSWORD_ATTEMPT_RATE_LIMIT } from '../common/rate-limits';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../common/auth/auth.guards';
import { ForgotPasswordDto, LoginDto, RegisterDto, ResetPasswordDto, SwitchRoleDto } from './auth.dto';
import { AuthService } from './auth.service';

/** Resposta fixa do pedido de redefinição (não revela se o e-mail tem conta). */
const FORGOT_MESSAGE = 'Se houver uma conta com este e-mail, enviamos um link para criar uma nova senha.';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @Throttle({ default: PASSWORD_ATTEMPT_RATE_LIMIT })
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('login')
  @Throttle({ default: PASSWORD_ATTEMPT_RATE_LIMIT })
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Post('switch-role')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  switchRole(@CurrentUser() user: AuthUser, @Body() dto: SwitchRoleDto) {
    return this.auth.switchRole(user, dto.role);
  }

  @Post('forgot-password')
  @Throttle({ default: AUTH_RATE_LIMIT })
  @HttpCode(200)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.auth.forgotPassword(dto.email);
    return { ok: true, message: FORGOT_MESSAGE };
  }

  @Post('reset-password')
  @Throttle({ default: AUTH_RATE_LIMIT })
  @HttpCode(200)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto.token, dto.password);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }
}
