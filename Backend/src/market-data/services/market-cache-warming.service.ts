import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MarketDataService, TOP_ASSETS } from './market-data.service';
import { MarketCacheService } from './market-cache.service';

@Injectable()
export class MarketCacheWarmingService {
  private readonly logger = new Logger(MarketCacheWarmingService.name);
  private isWarming = false;

  constructor(
    private readonly marketDataService: MarketDataService,
    private readonly cacheService: MarketCacheService,
  ) {}

  /**
   * Warm market snapshot cache every 30 seconds.
   * Refreshes top-N assets and individual asset price caches.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async warmMarketCache(): Promise<void> {
    // Guard against overlapping runs
    if (this.isWarming) {
      this.logger.debug('Cache warming already in progress, skipping');
      return;
    }
    this.isWarming = true;
    this.logger.debug('Cache warming cycle started');

    try {
      // 1. Warm the overall "all-assets" snapshot (bypassCache = true)
      await this.marketDataService.getMarketSnapshot(undefined, true);
      this.logger.debug('Warmed all-assets snapshot');

      // 2. Warm individual asset prices in parallel
      const priceResults = await Promise.allSettled(
        TOP_ASSETS.map((asset) =>
          this.marketDataService.getAssetPrice(asset.code, asset.issuer),
        ),
      );

      const successCount = priceResults.filter(
        (r) => r.status === 'fulfilled',
      ).length;
      const failCount = priceResults.filter(
        (r) => r.status === 'rejected',
      ).length;

      this.logger.log(
        `Cache warming complete: ${successCount}/${TOP_ASSETS.length} assets refreshed, ${failCount} failed`,
      );
    } catch (error) {
      this.logger.error(
        `Cache warming cycle failed: ${error.message}`,
        error.stack,
      );
    } finally {
      this.isWarming = false;
    }
  }

  /**
   * Run a forced cache warm on module init (after a brief delay so
   * the Horizon connection has time to stabilise on cold start).
   */
  onModuleInit(): void {
    // Delay the first warm by 5 seconds to allow dependencies to settle
    setTimeout(() => {
      this.logger.log('Performing initial cache warm on startup...');
      void this.warmMarketCache();
    }, 5000);
  }

  /**
   * Returns the current warming state — useful for health checks.
   */
  isCurrentlyWarming(): boolean {
    return this.isWarming;
  }

  /**
   * Returns cache stats for the market snapshot namespace.
   */
  getWarmingStats(): { isWarming: boolean; lastWarm?: Date } {
    return { isWarming: this.isWarming };
  }
}
