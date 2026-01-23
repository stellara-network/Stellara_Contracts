import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from './cache.service';
import { MarketCacheService } from './market-cache.service';
import { NewsCacheService } from './news-cache.service';

/**
 * Asset Update Event
 * Emitted when an asset is updated to trigger cache invalidation
 */
export class AssetUpdatedEvent {
  constructor(
    public readonly assetId: string,
    public readonly type: 'price' | 'volume' | 'metadata' | 'all',
  ) {}
}

/**
 * News Update Event
 * Emitted when news data changes to trigger cache invalidation
 */
export class NewsUpdatedEvent {
  constructor(
    public readonly category?: string,
    public readonly isTrending?: boolean,
  ) {}
}

/**
 * Cache Invalidation Service
 * Handles cache invalidation for different event types
 */
@Injectable()
export class CacheInvalidationService {
  private readonly logger = new Logger(CacheInvalidationService.name);
  private assetUpdateHandlers: Array<(event: AssetUpdatedEvent) => Promise<void>> = [];
  private newsUpdateHandlers: Array<(event: NewsUpdatedEvent) => Promise<void>> = [];

  constructor(
    private readonly cacheService: CacheService,
    private readonly marketCacheService: MarketCacheService,
    private readonly newsCacheService: NewsCacheService,
  ) {
    this.registerDefaultHandlers();
  }

  /**
   * Register default handlers for asset and news updates
   */
  private registerDefaultHandlers(): void {
    this.onAssetUpdated(async (event) => {
      await this.handleAssetUpdated(event);
    });

    this.onNewsUpdated(async (event) => {
      await this.handleNewsUpdated(event);
    });
  }

  /**
   * Register custom asset update handler
   */
  onAssetUpdated(handler: (event: AssetUpdatedEvent) => Promise<void>): void {
    this.assetUpdateHandlers.push(handler);
  }

  /**
   * Register custom news update handler
   */
  onNewsUpdated(handler: (event: NewsUpdatedEvent) => Promise<void>): void {
    this.newsUpdateHandlers.push(handler);
  }

  /**
   * Emit asset updated event to trigger cache invalidation
   */
  async emitAssetUpdated(assetId: string, type: 'price' | 'volume' | 'metadata' | 'all' = 'all'): Promise<void> {
    const event = new AssetUpdatedEvent(assetId, type);
    for (const handler of this.assetUpdateHandlers) {
      try {
        await handler(event);
      } catch (error) {
        this.logger.error(`Error in asset update handler:`, error);
      }
    }
  }

  /**
   * Emit news updated event to trigger cache invalidation
   */
  async emitNewsUpdated(category?: string, isTrending?: boolean): Promise<void> {
    const event = new NewsUpdatedEvent(category, isTrending);
    for (const handler of this.newsUpdateHandlers) {
      try {
        await handler(event);
      } catch (error) {
        this.logger.error(`Error in news update handler:`, error);
      }
    }
  }

  /**
   * Handle asset update events and invalidate cache
   */
  private async handleAssetUpdated(event: AssetUpdatedEvent): Promise<void> {
    this.logger.log(
      `Cache invalidation triggered for asset: ${event.assetId} (type: ${event.type})`,
    );

    switch (event.type) {
      case 'price':
      case 'volume':
        // Invalidate market snapshot when price or volume changes
        await this.marketCacheService.invalidateMarketCache(event.assetId);
        break;
      case 'metadata':
        // Invalidate extended data when metadata changes
        await this.cacheService.delete(
          `cache:market:snapshot:extended:${event.assetId}`,
        );
        break;
      case 'all':
        // Invalidate all market caches for the asset
        await this.marketCacheService.invalidateMarketCache(event.assetId);
        break;
    }
  }

  /**
   * Handle news update events and invalidate cache
   */
  private async handleNewsUpdated(event: NewsUpdatedEvent): Promise<void> {
    this.logger.log(
      `Cache invalidation triggered for news${event.category ? ` (category: ${event.category})` : ''}`,
    );

    if (event.category) {
      // Invalidate specific category cache
      await this.newsCacheService.invalidateNewsCategoryCache(event.category);
    } else {
      // Invalidate all news cache
      await this.newsCacheService.invalidateNewsCache();
    }

    if (event.isTrending) {
      // Also invalidate trending news cache
      await this.cacheService.delete('cache:news:trending');
    }
  }

  /**
   * Clear all caches (useful for emergency scenarios)
   */
  async clearAllCaches(): Promise<void> {
    this.logger.warn('Clearing all caches');
    await Promise.all([
      this.cacheService.deleteByPattern('cache:market:*'),
      this.cacheService.deleteByPattern('cache:news:*'),
      this.cacheService.deleteByPattern('cache:metrics:*'),
    ]);
  }
}

