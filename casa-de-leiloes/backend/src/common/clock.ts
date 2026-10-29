import { Global, Injectable, Module } from '@nestjs/common';

/**
 * Relógio injetável — permite controlar o "agora" nos testes
 * (anti-sniping, início/fim de lote, liquidação).
 */
@Injectable()
export class Clock {
  private offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  /** Somente para testes: avança o relógio. */
  advance(ms: number) {
    this.offsetMs += ms;
  }

  /** Somente para testes: volta ao relógio real. */
  reset() {
    this.offsetMs = 0;
  }
}

@Global()
@Module({ providers: [Clock], exports: [Clock] })
export class ClockModule {}

/** Janela do anti-sniping: lance nos últimos 2 min empurra o fim para agora + 2 min. */
export const ANTI_SNIPING_WINDOW_MS = 2 * 60 * 1000;
