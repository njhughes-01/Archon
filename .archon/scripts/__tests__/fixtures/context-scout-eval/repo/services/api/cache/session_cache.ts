interface Entry<T> {
  value: T;
  storedAt: number;
}

/**
 * Keeps recently loaded shopping sessions (a visitor's cart and last page) in
 * memory so a page view does not hit the database. It stores and evicts; it
 * makes no decision about who the visitor is.
 */
export class SessionCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly capacity: number,
    private readonly maxAgeMs: number
  ) {}

  get(id: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (now - entry.storedAt > this.maxAgeMs) {
      this.entries.delete(id);
      return undefined;
    }
    return entry.value;
  }

  set(id: string, value: T, now = Date.now()): void {
    if (this.entries.size >= this.capacity && !this.entries.has(id)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(id, { value, storedAt: now });
  }
}
