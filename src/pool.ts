// A counting semaphore that bounds how many async operations run at once.
// Every agent call (batch review + synthesis) across all PRs acquires this, so
// total concurrent Opus calls is hard-capped regardless of PR/batch counts.

export class Semaphore {
  private readonly capacity: number;
  private inUse = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  private async acquire(): Promise<void> {
    if (this.inUse < this.capacity) {
      this.inUse++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inUse++;
  }

  private release(): void {
    this.inUse--;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** Run `fn` once a slot is free; the slot is released even if `fn` throws. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
