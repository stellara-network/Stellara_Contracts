import { Injectable } from '@nestjs/common';
import { CacheService } from './cache.service';
import { generateCacheKey, CACHE_CONFIG } from './cache.config';

/**
 * News Cache Service
 * Handles caching of news articles and market updates
 */
@Injectable()
export class NewsCacheService {
  constructor(private readonly cacheService: CacheService) {}

  /**
   * Get news articles (optionally filtered by category)
   */
  async getNews<T>(
    category: string | 'all' = 'all',
    provider: () => Promise<T>,
  ): Promise<T> {
    const key = generateCacheKey(
      CACHE_CONFIG.NEWS.prefix,
      category === 'all' ? '' : category,
    );
    return this.cacheService.getOrSet(
      key,
      provider,
      CACHE_CONFIG.NEWS.ttl,
    );
  }

  /**
   * Get trending news
   */
  async getTrendingNews<T>(provider: () => Promise<T>): Promise<T> {
    const key = generateCacheKey(CACHE_CONFIG.NEWS_TRENDING.prefix);
    return this.cacheService.getOrSet(
      key,
      provider,
      CACHE_CONFIG.NEWS_TRENDING.ttl,
    );
  }

  /**
   * Invalidate all news cache
   */
  async invalidateNewsCache(): Promise<void> {
    await Promise.all([
      this.cacheService.deleteByPattern(`${CACHE_CONFIG.NEWS.prefix}:*`),
      this.cacheService.deleteByPattern(`${CACHE_CONFIG.NEWS_TRENDING.prefix}:*`),
    ]);
  }

  /**
   * Invalidate specific news category cache
   */
  async invalidateNewsCategoryCache(category: string): Promise<void> {
    const key = generateCacheKey(CACHE_CONFIG.NEWS.prefix, category);
    await this.cacheService.delete(key);
  }
}
