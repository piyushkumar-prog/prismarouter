/**
 * A simple async semaphore with bounded queue.
 */
export class Semaphore {
  private running = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {}

  /**
   * Acquire a slot. Resolves when a slot is available.
   * Returns a release function.
   */
  acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      const tryAcquire = (): void => {
        if (this.running < this.maxConcurrency) {
          this.running++;
          resolve(() => this.release());
        } else {
          this.waiters.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  private release(): void {
    this.running--;
    const next = this.waiters.shift();
    if (next) next();
  }

  get activeCount(): number {
    return this.running;
  }

  get queueDepth(): number {
    return this.waiters.length;
  }
}
