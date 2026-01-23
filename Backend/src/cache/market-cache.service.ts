import { Injectable } from '@nestjs/common';
import { CacheService } from './cache.service';
import { generateCacheKey, CACHE_CONFIG } from './cache.config';

/**
 * Market Data Cache Service
 * Handles caching of market snapshots and related data
 */
@Injectable()
export class MarketCacheService {
  constructor(private readonly cacheService: CacheService) {}

  /**
   * Get market snapshot (e.g., prices, volumes for specific asset)
   */
  async getMarketSnapshot<T>(
    assetId: string,
    provider: () => Promise<T>,
  ): Promise<T> {
    const key = generateCacheKey(
      CACHE_CONFIG.MARKET_SNAPSHOT.prefix,
      assetId,
    );
    return this.cacheService.getOrSet(
      key,
      provider,
      CACHE_CONFIG.MARKET_SNAPSHOT.ttl,
    );
  }

  /**
   * Get extended market data (technical indicators, etc.)
   */
  async getExtendedMarketData<T>(
    assetId: string,
    provider: () => Promise<T>,
  ): Promise<T> {
    const key = generateCacheKey(
      CACHE_CONFIG.MARKET_SNAPSHOT_EXTENDED.prefix,
      assetId,
    );
    return this.cacheService.getOrSet(
      key,
      provider,
      CACHE_CONFIG.MARKET_SNAPSHOT_EXTENDED.ttl,
    );
  }

  /**
   * Invalidate market cache for specific asset
   */
  async invalidateMarketCache(assetId: string): Promise<void> {
    const snapshotKey = generateCacheKey(
      CACHE_CONFIG.MARKET_SNAPSHOT.prefix,
      assetId,
    );
    const extendedKey = generateCacheKey(
      CACHE_CONFIG.MARKET_SNAPSHOT_EXTENDED.prefix,
      assetId,
    );

    await Promise.all([
      this.cacheService.delete(snapshotKey),
      this.cacheService.delete(extendedKey),
    ]);
  }
}
