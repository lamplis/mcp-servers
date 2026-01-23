export class LruCache<TValue> {
  private readonly map = new Map<string, TValue>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("maxEntries must be a positive integer");
    }
  }

  get size(): number {
    return this.map.size;
  }

  get capacity(): number {
    return this.maxEntries;
  }

  get(key: string): TValue | undefined {
    const value = this.map.get(key);
    if (value === undefined) {
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: TValue): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    if (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value as string | undefined;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
  }
}
