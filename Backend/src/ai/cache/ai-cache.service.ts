import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { Redis } from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';

export interface CacheEntry {
  value: string;
  expiresAt: number;
}

/**
 * Service managing AI response caching, concurrent request deduplication,
 * and pattern-based cache invalidation.
 */
@Injectable()
export class AiCacheService {
  private readonly logger = new Logger(AiCacheService.name);
  private readonly defaultTtl: number;
  private readonly inMemoryCache = new Map<string, CacheEntry>();
  private readonly inflightRequests = new Map<string, Promise<any>>();

  constructor(
    @Optional()
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis | null = null,
    @Optional() private readonly redisService?: RedisService,
    @Optional() private readonly configService?: ConfigService,
  ) {
    this.defaultTtl = Number(
      this.configService?.get<number>('AI_CACHE_TTL') ?? 3600,
    );
  }

  /**
   * Deterministically hash prompt and model into a unique cache key.
   */
  buildKey(input: string, model = 'gpt-4'): string {
    return `ai:${model}:${createHash('sha256').update(input).digest('hex')}`;
  }

  /**
   * Get cached result for a key. Checks Redis first if available,
   * then falls back to in-memory cache with TTL verification.
   */
  async get(key: string): Promise<string | null> {
    if (this.redisService?.client) {
      try {
        const val = await this.redisService.client.get(key);
        if (val !== null && val !== undefined) return val;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Redis get failed for ${key}: ${msg}`);
      }
    } else if (this.redis) {
      try {
        const val = await this.redis.get(key);
        if (val !== null && val !== undefined) return val;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`ioredis get failed for ${key}: ${msg}`);
      }
    }

    const entry = this.inMemoryCache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.inMemoryCache.delete(key);
      return null;
    }

    return entry.value;
  }

  /**
   * Cache a response under key with TTL (seconds).
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? this.defaultTtl;

    if (this.redisService?.client) {
      try {
        await this.redisService.client.set(key, value, { EX: ttl });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Redis set failed for ${key}: ${msg}`);
      }
    } else if (this.redis) {
      try {
        await this.redis.set(key, value, 'EX', ttl);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`ioredis set failed for ${key}: ${msg}`);
      }
    }

    this.inMemoryCache.set(key, {
      value,
      expiresAt: Date.now() + ttl * 1000,
    });
  }

  /**
   * Coalesce concurrent in-flight requests for identical keys.
   * If an in-flight request exists, awaits and returns it with deduped: true.
   * Otherwise executes factory(), stores the promise in inflight map, and cleans up when done.
   */
  async deduplicate<T>(
    key: string,
    factory: () => Promise<T>,
  ): Promise<{ data: T; deduped: boolean }> {
    const active = this.inflightRequests.get(key) as Promise<T> | undefined;
    if (active) {
      const data = await active;
      return { data, deduped: true };
    }

    const promise = factory();
    this.inflightRequests.set(key, promise);

    try {
      const data = await promise;
      return { data, deduped: false };
    } finally {
      this.inflightRequests.delete(key);
    }
  }

  /**
   * Check if a request for the given key is currently in-flight.
   */
  isInflight(key: string): boolean {
    return this.inflightRequests.has(key);
  }

  /**
   * Current number of active in-flight requests.
   */
  getInflightCount(): number {
    return this.inflightRequests.size;
  }

  /**
   * Invalidate a single key from cache.
   */
  async del(key: string): Promise<boolean> {
    const inMemoryExisted = this.inMemoryCache.delete(key);
    let redisDeleted = false;

    if (this.redisService?.client) {
      try {
        const count = await this.redisService.client.del(key);
        redisDeleted = count > 0;
      } catch {
        // Ignore redis del failure
      }
    } else if (this.redis) {
      try {
        const count = await this.redis.del(key);
        redisDeleted = count > 0;
      } catch {
        // Ignore redis del failure
      }
    }

    return inMemoryExisted || redisDeleted;
  }

  /**
   * Invalidate all keys matching a glob pattern (e.g. `ai:gpt-4:*` or `ai:*`).
   */
  async invalidateByPattern(pattern: string): Promise<number> {
    let deletedCount = 0;

    // In-memory pattern invalidation
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    for (const k of Array.from(this.inMemoryCache.keys())) {
      if (regex.test(k)) {
        this.inMemoryCache.delete(k);
        deletedCount++;
      }
    }

    // Redis invalidation
    if (this.redisService?.client) {
      try {
        const keys = await this.redisService.scanKeys(pattern);
        if (keys.length > 0) {
          const count = await this.redisService.client.del(keys);
          deletedCount = Math.max(deletedCount, count);
        }
      } catch {
        // Ignore redis pattern del failure
      }
    } else if (this.redis?.keys) {
      try {
        const keys = await this.redis.keys(pattern);
        if (keys.length > 0) {
          const count = await this.redis.del(...keys);
          deletedCount = Math.max(deletedCount, count);
        }
      } catch {
        // Ignore redis pattern del failure
      }
    }

    return deletedCount;
  }

  /**
   * Invalidate cached responses for a specific prompt and model.
   */
  async invalidatePrompt(prompt: string, model = 'gpt-4'): Promise<boolean> {
    const key = this.buildKey(prompt, model);
    return this.del(key);
  }

  /**
   * Invalidate all cached responses for a specific model.
   */
  async invalidateModel(model: string): Promise<number> {
    return this.invalidateByPattern(`ai:${model}:*`);
  }

  /**
   * Clear all AI cache entries and in-flight tracking.
   */
  async clear(): Promise<void> {
    this.inMemoryCache.clear();
    this.inflightRequests.clear();
    await this.invalidateByPattern('ai:*');
  }

  /**
   * Number of active (non-expired) in-memory entries.
   */
  size(): number {
    const now = Date.now();
    let count = 0;
    for (const [key, entry] of this.inMemoryCache.entries()) {
      if (now <= entry.expiresAt) {
        count++;
      } else {
        this.inMemoryCache.delete(key);
      }
    }
    return count;
  }
}
