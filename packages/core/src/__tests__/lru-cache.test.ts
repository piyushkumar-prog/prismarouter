import { describe, it, expect, vi } from 'vitest';
import { LRUCache } from '../lru-cache.js';

describe('LRUCache', () => {
  it('returns the value from factory', async () => {
    const cache = new LRUCache<number>({ maxSize: 10 });
    const val = await cache.getOrCreate('a', async () => 42);
    expect(val).toBe(42);
  });

  it('reuses cached value without calling factory again', async () => {
    const factory = vi.fn(async () => 1);
    const cache = new LRUCache<number>({ maxSize: 10 });
    await cache.getOrCreate('a', factory);
    await cache.getOrCreate('a', factory);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('single-flight: concurrent first requests share one factory call', async () => {
    const factory = vi.fn(
      () => new Promise<number>((resolve) => setTimeout(() => resolve(99), 10)),
    );
    const cache = new LRUCache<number>({ maxSize: 10 });

    const [a, b, c] = await Promise.all([
      cache.getOrCreate('key', factory),
      cache.getOrCreate('key', factory),
      cache.getOrCreate('key', factory),
    ]);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(a).toBe(99);
    expect(b).toBe(99);
    expect(c).toBe(99);
  });

  it('evicts LRU entry when maxSize exceeded', async () => {
    const evicted: string[] = [];
    const cache = new LRUCache<number>({
      maxSize: 2,
      onEvict: (key) => {
        evicted.push(key);
      },
    });

    await cache.getOrCreate('a', async () => 1);
    await cache.getOrCreate('b', async () => 2);
    await cache.getOrCreate('c', async () => 3); // 'a' should be evicted (LRU)

    expect(evicted).toContain('a');
    expect(cache.size).toBe(2);
  });

  it('onEvict is called on explicit delete', async () => {
    const evicted: string[] = [];
    const cache = new LRUCache<number>({
      maxSize: 10,
      onEvict: (key) => {
        evicted.push(key);
      },
    });

    await cache.getOrCreate('x', async () => 5);
    await cache.delete('x');

    expect(evicted).toContain('x');
    expect(cache.size).toBe(0);
  });

  it('propagates factory errors', async () => {
    const cache = new LRUCache<number>({ maxSize: 10 });
    await expect(
      cache.getOrCreate('err', async () => {
        throw new Error('factory failed');
      }),
    ).rejects.toThrow('factory failed');
    // Should not be cached
    expect(cache.size).toBe(0);
  });
});
