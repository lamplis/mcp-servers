export class Semaphore {
  private activeCount = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0) {
      throw new Error("maxConcurrency must be a positive integer");
    }
  }

  async acquire(): Promise<() => void> {
    if (this.activeCount < this.maxConcurrency) {
      this.activeCount += 1;
      return () => this.release();
    }

    return new Promise((resolve) => {
      this.queue.push(() => {
        this.activeCount += 1;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.activeCount -= 1;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}
