/**
 * Cache Configuration
 * Defines TTLs and key patterns for different types of cached data
 */

export enum CacheKeyPrefix {
  MARKET_SNAPSHOT = 'cache:market:snapshot',
  NEWS = 'cache:news',
  METRICS = 'cache:metrics',
}

export interface CacheConfig {
  ttl: number; // Time to live in seconds
  prefix: string;
  description: string;
}

/**
 * Cache TTL Configuration
 * Adjust these values based on your requirements
 */
export const CACHE_CONFIG: Record<string, CacheConfig> = {
  MARKET_SNAPSHOT: {
    ttl: 60, // 1 minute
    prefix: CacheKeyPrefix.MARKET_SNAPSHOT,
    description: 'Market snapshot data (prices, volumes, etc.)',
  },
  MARKET_SNAPSHOT_EXTENDED: {
    ttl: 300, // 5 minutes
    prefix: `${CacheKeyPrefix.MARKET_SNAPSHOT}:extended`,
    description: 'Extended market data with technical indicators',
  },
  NEWS: {
    ttl: 600, // 10 minutes
    prefix: CacheKeyPrefix.NEWS,
    description: 'Crypto news and market updates',
  },
  NEWS_TRENDING: {
    ttl: 300, // 5 minutes
    prefix: `${CacheKeyPrefix.NEWS}:trending`,
    description: 'Trending news articles',
  },
};

/**
 * Generate cache key with prefix
 */
export function generateCacheKey(prefix: string, ...parts: string[]): string {
  return [prefix, ...parts].filter(Boolean).join(':');
}

/**
 * Extract cache metadata from key
 */
export function parseCacheKey(key: string): { prefix: string; parts: string[] } {
  const [prefix, ...parts] = key.split(':');
  return { prefix, parts };
}
