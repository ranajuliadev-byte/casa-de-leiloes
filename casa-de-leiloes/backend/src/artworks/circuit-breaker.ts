/**
 * Circuit breaker simples (fechado → aberto → meio-aberto).
 *  - Fechado: chamadas passam; cada falha soma 1, sucesso zera.
 *  - Após `threshold` falhas seguidas abre por `openMs`: ninguém chama a API.
 *  - Passado o tempo, deixa UMA chamada de teste passar (meio-aberto):
 *    sucesso fecha, falha reabre por mais `openMs`.
 * O "agora" vem de fora (Clock) para os testes controlarem o tempo.
 */
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private failures = 0;
  private openedUntil = 0;
  private probing = false;

  constructor(
    private readonly now: () => number,
    readonly threshold = 3,
    readonly openMs = 30_000,
  ) {}

  get state(): BreakerState {
    if (this.openedUntil === 0) return 'CLOSED';
    return this.now() < this.openedUntil ? 'OPEN' : 'HALF_OPEN';
  }

  /** Pode chamar a API agora? Em meio-aberto, libera só uma chamada por vez. */
  tryAcquire(): boolean {
    const s = this.state;
    if (s === 'CLOSED') return true;
    if (s === 'OPEN') return false;
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  onSuccess() {
    this.failures = 0;
    this.openedUntil = 0;
    this.probing = false;
  }

  onFailure() {
    this.probing = false;
    this.failures++;
    if (this.openedUntil !== 0 || this.failures >= this.threshold) {
      this.openedUntil = this.now() + this.openMs;
    }
  }
}
