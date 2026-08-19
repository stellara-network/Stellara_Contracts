import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MarketCacheService } from './market-cache.service';
import { CacheNamespace } from '../types/cache-config.types';

export interface AssetUpdateEvent {
  assetCode: string;
  issuer: string;
  updateType: 'price' | 'metadata' | 'trustlines';
  timestamp: Date;
}

export interface CacheInvalidationEvent {
  namespace: CacheNamespace;
  keys?: string[];
  pattern?: string;
  reason: string;
}

@Injectable()
export class CacheInvalidationService {
  private readonly logger = new Logger(CacheInvalidationService.name);

  constructor(
    private readonly cacheService: MarketCacheService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @OnEvent('asset.updated')
  async handleAssetUpdate(event: AssetUpdateEvent) {
    try {
      this.logger.log(`Asset updated: ${event.assetCode}, ${event.updateType}`);

      // Invalidate price data cache for the specific asset
      await this.cacheService.invalidateByPattern(
        event.assetCode,
        CacheNamespace.PRICE_DATA,
      );

      // Invalidate market snapshots (they include all assets)
      await this.cacheService.invalidateNamespace(
        CacheNamespace.MARKET_SNAPSHOT,
      );

      this.logger.log(`Cache invalidated for asset: ${event.assetCode}`);

      // Emit cache invalidation event for monitoring
      this.eventEmitter.emit('cache.invalidated', {
        namespace: CacheNamespace.PRICE_DATA,
        pattern: event.assetCode,
        reason: `Asset update: ${event.updateType}`,
      } as CacheInvalidationEvent);
    } catch (error) {
      this.logger.error('Error handling asset update:', error);
    }
  }

  @OnEvent('news.published')
  async handleNewsPublished() {
    try {
      this.logger.log('News published event received');

      // Invalidate news cache
      await this.cacheService.invalidateNamespace(CacheNamespace.NEWS);

      this.logger.log('News cache invalidated');

      // Emit cache invalidation event
      this.eventEmitter.emit('cache.invalidated', {
        namespace: CacheNamespace.NEWS,
        reason: 'New article published',
      } as CacheInvalidationEvent);
    } catch (error) {
      this.logger.error('Error handling news published:', error);
    }
  }

  @OnEvent('cache.invalidate.manual')
  async handleManualInvalidation(event: {
    namespace?: CacheNamespace;
    keys?: string[];
    pattern?: string;
  }) {
    try {
      this.logger.log(
        `Manual cache invalidation requested: ${JSON.stringify(event)}`,
      );

      let invalidatedCount = 0;

      if (event.pattern && event.namespace) {
        invalidatedCount = await this.cacheService.invalidateByPattern(
          event.pattern,
          event.namespace,
        );
      } else if (event.keys && event.namespace) {
        invalidatedCount = await this.cacheService.invalidate(
          event.keys,
          event.namespace,
        );
      } else if (event.namespace) {
        invalidatedCount = await this.cacheService.invalidateNamespace(
          event.namespace,
        );
      }

      this.logger.log(
        `Manual invalidation completed: ${invalidatedCount} keys removed`,
      );

      // Emit cache invalidation event
      this.eventEmitter.emit('cache.invalidated', {
        ...event,
        reason: 'Manual invalidation',
      } as CacheInvalidationEvent);
    } catch (error) {
      this.logger.error('Error in manual invalidation:', error);
    }
  }

  // Public trigger methods
  triggerAssetUpdate(
    assetCode: string,
    issuer: string,
    updateType: 'price' | 'metadata' | 'trustlines',
  ) {
    try {
      this.eventEmitter.emit('asset.updated', {
        assetCode,
        issuer,
        updateType,
        timestamp: new Date(),
      } as AssetUpdateEvent);
    } catch (error) {
      this.logger.error('Error triggering asset update:', error);
    }
  }

  triggerNewsPublished() {
    try {
      this.eventEmitter.emit('news.published');
    } catch (error) {
      this.logger.error('Error triggering news published:', error);
    }
  }

  triggerManualInvalidation(
    namespace?: CacheNamespace,
    keys?: string[],
    pattern?: string,
  ) {
    try {
      this.eventEmitter.emit('cache.invalidate.manual', {
        namespace,
        keys,
        pattern,
      });
    } catch (error) {
      this.logger.error('Error triggering manual invalidation:', error);
    }
  }
}
