import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import {
  CACHE_CONFIG,
  generateCacheKey,
  parseCacheKey,
  CacheKeyPrefix,
} from './cache.config';

export interface CacheMetrics {
  hits: number;
  misses: number;
  hitRate: number;
  totalRequests: number;
}

/**
 * Cache Service
 * Provides abstraction for Redis-based caching with metrics tracking
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private metrics: Map<string, { hits: number; misses: number }> = new Map();

  constructor(private readonly redisService: RedisService) {
    this.initializeMetrics();
  }

  /**
   * Initialize metrics tracking for all cache keys
   * Uses simplified prefixes: cache:market, cache:news
   * This aggregates metrics across all related cache types
   */
  private initializeMetrics(): void {
    const prefixSet = new Set<string>();
    
    Object.entries(CACHE_CONFIG).forEach(([key, config]) => {
      // Extract simplified prefix (first two parts): cache:market, cache:news
      const parts = config.prefix.split(':');
      const simplifiedPrefix = parts.length >= 2 
        ? `${parts[0]}:${parts[1]}` 
        : parts[0];
      
      prefixSet.add(simplifiedPrefix);
    });

    // Initialize metrics for each simplified prefix
    prefixSet.forEach((prefix) => {
      this.metrics.set(prefix, { hits: 0, misses: 0 });
    });
  }

  /**
   * Get value from cache
   * Returns null if key doesn't exist or has expired
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await this.redisService.client.get(key);

      if (value) {
        this.recordHit(key);
        return JSON.parse(value) as T;
      }

      this.recordMiss(key);
      return null;
    } catch (error) {
      this.logger.error(`Error getting cache key ${key}:`, error);
      this.recordMiss(key);
      return null;
    }
  }

  /**
   * Set value in cache with TTL
   */
  async set<T>(
    key: string,
    value: T,
    ttlSeconds?: number,
  ): Promise<void> {
    try {
      const ttl = ttlSeconds !== undefined ? ttlSeconds : this.getTtlForKey(key);
      const serialized = JSON.stringify(value);

      if (ttl > 0) {
        await this.redisService.client.setEx(key, ttl, serialized);
        this.logger.debug(
          `Cached key: ${key} (TTL: ${ttl}s)`,
        );
      } else {
        await this.redisService.client.set(key, serialized);
        this.logger.debug(`Cached key: ${key} (no expiration)`);
      }
    } catch (error) {
      this.logger.error(`Error setting cache key ${key}:`, error);
    }
  }

  /**
   * Get or set pattern
   * Returns cached value if exists, otherwise calls provider function and caches result
   */
  async getOrSet<T>(
    key: string,
    provider: () => Promise<T>,
    ttlSeconds?: number,
  ): Promise<T> {
    // Try to get from cache
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    // Fetch and cache
    try {
      const data = await provider();
      await this.set(key, data, ttlSeconds);
      return data;
    } catch (error) {
      this.logger.error(`Error in getOrSet provider for key ${key}:`, error);
      throw error;
    }
  }

  /**
   * Delete specific cache key
   */
  async delete(key: string): Promise<void> {
    try {
      await this.redisService.client.del(key);
      this.logger.debug(`Deleted cache key: ${key}`);
    } catch (error) {
      this.logger.error(`Error deleting cache key ${key}:`, error);
    }
  }

  /**
   * Delete keys by pattern (use with caution)
   */
  async deleteByPattern(pattern: string): Promise<number> {
    try {
      const keys = await this.redisService.client.keys(pattern);
      if (keys.length > 0) {
        const deleted = await this.redisService.client.del(keys);
        this.logger.debug(`Deleted ${deleted} cache keys matching pattern: ${pattern}`);
        return deleted;
      }
      return 0;
    } catch (error) {
      this.logger.error(`Error deleting cache keys by pattern ${pattern}:`, error);
      return 0;
    }
  }

  /**
   * Clear all cache metrics
   */
  async clearMetrics(): Promise<void> {
    this.metrics.clear();
    this.initializeMetrics();
    this.logger.debug('Cache metrics cleared');
  }

  /**
   * Invalidate cache for a specific entity
   * Used when data changes (e.g., asset update)
   */
  async invalidateEntityCache(entityType: string, entityId?: string): Promise<void> {
    const pattern = entityId
      ? `cache:*:${entityType}:${entityId}:*`
      : `cache:*:${entityType}:*`;

    const deleted = await this.deleteByPattern(pattern);
    this.logger.log(
      `Invalidated ${deleted} cache entries for ${entityType}${entityId ? ` (${entityId})` : ''}`,
    );
  }

  /**
   * Get cache metrics
   */
  getMetrics(): Record<string, CacheMetrics> {
    const result: Record<string, CacheMetrics> = {};

    this.metrics.forEach((metric, prefix) => {
      const total = metric.hits + metric.misses;
      result[prefix] = {
        hits: metric.hits,
        misses: metric.misses,
        hitRate: total > 0 ? (metric.hits / total) * 100 : 0,
        totalRequests: total,
      };
    });

    return result;
  }

  /**
   * Get Redis info
   */
  async getRedisInfo(): Promise<string> {
    try {
      return await this.redisService.client.info();
    } catch (error) {
      this.logger.error('Error fetching Redis info:', error);
      return 'Unable to fetch Redis info';
    }
  }

  /**
   * Record cache hit
   */
  private recordHit(key: string): void {
    const configPrefix = this.findMatchingConfigPrefix(key);
    const metric = this.metrics.get(configPrefix);
    if (metric) {
      metric.hits++;
    }
  }

  /**
   * Record cache miss
   */
  private recordMiss(key: string): void {
    const configPrefix = this.findMatchingConfigPrefix(key);
    const metric = this.metrics.get(configPrefix);
    if (metric) {
      metric.misses++;
    }
  }

  /**
   * Get TTL for a specific key based on config
   */
  private getTtlForKey(key: string): number {
    const configPrefix = this.findMatchingConfigPrefix(key);
    const config = Object.values(CACHE_CONFIG).find(
      (c) => c.prefix === configPrefix,
    );
    return config?.ttl || 300; // Default 5 minutes
  }

  /**
   * Find which CACHE_CONFIG prefix matches the given cache key
   * Returns the SIMPLIFIED prefix for metrics (cache:market, cache:news)
   * Examples:
   * - cache:market:snapshot:USD-STELLARA → cache:market
   * - cache:market:snapshot:extended:USD-STELLARA → cache:market
   * - cache:news:blockchain → cache:news
   */
  private findMatchingConfigPrefix(key: string): string {
    // Sort prefixes by length (longest first) to match most specific first
    const sortedConfigs = Object.values(CACHE_CONFIG)
      .sort((a, b) => b.prefix.length - a.prefix.length);

    for (const config of sortedConfigs) {
      if (key.startsWith(config.prefix)) {
        // Return simplified prefix (first two parts) for metrics
        const parts = config.prefix.split(':');
        return parts.length >= 2 
          ? `${parts[0]}:${parts[1]}` 
          : parts[0];
      }
    }

    // Fallback: return first two parts
    const parts = key.split(':');
    return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : parts[0];
  }
}
