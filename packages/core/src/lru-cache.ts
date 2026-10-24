/**
 * LRU cache with:
 *  - single-flight creation (concurrent first-requests share one Promise)
 *  - idle TTL eviction
 *  - async disposal on eviction
 */
export interface LRUCacheOptions<V> {
  maxSize: number;
  /** Milliseconds of idle time before an entry is eligible for eviction. 0 = no TTL. */
  idleTtlMs?: number;
  /** Called when an entry is evicted (by capacity or TTL). */
  onEvict?: (key: string, value: V) => Promise<void> | void;
}

interface Entry<V> {
  value: V;
  lastUsed: number;
}

export class LRUCache<V> {
  private readonly map = new Map<string, Entry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();
  private readonly options: Required<LRUCacheOptions<V>>;

  constructor(options: LRUCacheOptions<V>) {
    this.options = {
      maxSize: options.maxSize,
      idleTtlMs: options.idleTtlMs ?? 0,
      onEvict: options.onEvict ?? (() => undefined),
    };
  }

  /**
   * Get or create an entry.
   * Concurrent calls with the same key share a single creation Promise (single-flight).
   */
  async getOrCreate(key: string, factory: () => Promise<V>): Promise<V> {
    // Check existing entry
    const existing = this.map.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.value;
    }

    // Check in-flight
    const inFlight = this.inflight.get(key);
    if (inFlight) return inFlight;

    // Create new
    const promise = factory()
      .then((value) => {
        this.inflight.delete(key);
        this.set(key, value);
        return value;
      })
      .catch((err: unknown) => {
        this.inflight.delete(key);
        throw err;
      });

    this.inflight.set(key, promise);
    return promise;
  }

  private set(key: string, value: V): void {
    // Evict expired entries first
    if (this.options.idleTtlMs > 0) {
      this.evictExpired();
    }

    // Evict LRU if at capacity
    while (this.map.size >= this.options.maxSize) {
      this.evictLRU();
    }

    this.map.set(key, { value, lastUsed: Date.now() });
  }

  /** Synchronously retrieve an entry without updating LRU order. */
  peek(key: string): V | undefined {
    return this.map.get(key)?.value;
  }

  /** Explicitly delete an entry and trigger onEvict. */
  async delete(key: string): Promise<void> {
    const entry = this.map.get(key);
    if (entry) {
      this.map.delete(key);
      await this.options.onEvict(key, entry.value);
    }
  }

  /** Size of the cache (not counting in-flight). */
  get size(): number {
    return this.map.size;
  }

  /** Number of in-flight creation promises. */
  get inflightCount(): number {
    return this.inflight.size;
  }

  private evictExpired(): void {
    const now = Date.now();
    const ttl = this.options.idleTtlMs;
    for (const [key, entry] of this.map) {
      if (now - entry.lastUsed > ttl) {
        this.map.delete(key);
        void this.options.onEvict(key, entry.value);
      }
    }
  }

  private evictLRU(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;

    for (const [key, entry] of this.map) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestKey = key;
      }
    }

    if (oldestKey !== undefined) {
      const entry = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      if (entry) void this.options.onEvict(oldestKey, entry.value);
    }
  }

  /** Evict all entries and call onEvict for each. */
  async clear(): Promise<void> {
    const entries = [...this.map.entries()];
    this.map.clear();
    await Promise.all(entries.map(([key, entry]) => this.options.onEvict(key, entry.value)));
  }
}
