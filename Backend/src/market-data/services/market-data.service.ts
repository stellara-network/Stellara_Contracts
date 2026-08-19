import { Injectable, Logger } from '@nestjs/common';
import { MarketCacheService } from './market-cache.service';
import { HorizonMarketDataProvider } from './horizon-market-data-provider.service';
import { CacheNamespace } from '../types/cache-config.types';
import { MarketSnapshotDto, AssetPriceDto } from '../dto/market-snapshot.dto';

// ---------------------------------------------------------------------------
// Circuit Breaker Configuration
// ---------------------------------------------------------------------------
const CIRCUIT_OPEN_AFTER_FAILURES = 5;
const CIRCUIT_RESET_AFTER_MS = 30_000; // 30 seconds

enum CircuitState {
  CLOSED = 'CLOSED', // Normal operation
  OPEN = 'OPEN', // Blocking calls, using fallback
  HALF_OPEN = 'HALF_OPEN', // Allowing one probe to test health
}

// ---------------------------------------------------------------------------
// Top-N assets to pre-warm (code + issuer pair)
// ---------------------------------------------------------------------------
export const TOP_ASSETS: { code: string; issuer: string }[] = [
  { code: 'XLM', issuer: 'native' },
  {
    code: 'USDC',
    issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  },
  {
    code: 'AQUA',
    issuer: 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA',
  },
  {
    code: 'yXLM',
    issuer: 'GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55',
  },
];

// Last-resort hardcoded fallback — used only if no cache & horizon is down
const HARDCODED_FALLBACK: AssetPriceDto[] = [
  {
    code: 'XLM',
    issuer: 'native',
    priceUSD: 0.125,
    change24h: 0,
    volume24h: 0,
    marketCap: 0,
    dataFreshness: 'hardcoded_fallback',
    source: 'Hardcoded fallback',
  },
  {
    code: 'USDC',
    issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    priceUSD: 1.0,
    change24h: 0,
    volume24h: 0,
    marketCap: 0,
    dataFreshness: 'hardcoded_fallback',
    source: 'Hardcoded fallback',
  },
];

// ---------------------------------------------------------------------------
// Lock registry — prevents stampeding herd on background refreshes
// ---------------------------------------------------------------------------
const refreshLocks = new Map<string, boolean>();

@Injectable()
export class MarketDataService {
  private readonly logger = new Logger(MarketDataService.name);

  // Circuit breaker state
  private circuitState: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly cacheService: MarketCacheService,
    private readonly horizonProvider: HorizonMarketDataProvider,
  ) {}

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  /**
   * Get market snapshot for multiple assets using SWR + circuit breaker.
   */
  async getMarketSnapshot(
    assetFilter?: string[],
    bypassCache: boolean = false,
  ): Promise<MarketSnapshotDto> {
    const cacheKey = this.generateMarketSnapshotKey(assetFilter);

    if (!bypassCache) {
      const cached = await this.cacheService.get<MarketSnapshotDto>(
        cacheKey,
        CacheNamespace.MARKET_SNAPSHOT,
      );

      if (cached) {
        const stale = await this.cacheService.isStale(
          cacheKey,
          CacheNamespace.MARKET_SNAPSHOT,
        );

        if (!stale) {
          this.logger.debug('Serving fresh market snapshot from cache');
          return { ...cached, cached: true, dataFreshness: 'fresh' };
        }

        // --- Stale-While-Revalidate: serve stale, refresh in background ---
        this.logger.debug(
          'Stale market snapshot — serving immediately, refreshing in background',
        );
        this.backgroundRefreshSnapshot(cacheKey, assetFilter);
        return { ...cached, cached: true, dataFreshness: 'stale' };
      }
    }

    // Cache miss or bypassed: fetch synchronously
    return this.fetchAndCacheSnapshot(cacheKey, assetFilter, bypassCache);
  }

  /**
   * Get single asset price with SWR + circuit breaker.
   */
  async getAssetPrice(
    assetCode: string,
    issuer: string,
  ): Promise<AssetPriceDto | null> {
    const cacheKey = `${assetCode}:${issuer}`;

    const cached = await this.cacheService.get<AssetPriceDto>(
      cacheKey,
      CacheNamespace.PRICE_DATA,
    );

    if (cached) {
      const stale = await this.cacheService.isStale(
        cacheKey,
        CacheNamespace.PRICE_DATA,
      );

      if (!stale) {
        this.logger.debug(`Serving fresh ${assetCode} price from cache`);
        return { ...cached, dataFreshness: 'fresh' };
      }

      // SWR: serve stale, refresh in background
      this.backgroundRefreshAssetPrice(cacheKey, assetCode, issuer);
      return { ...cached, dataFreshness: 'stale' };
    }

    return this.fetchAndCacheAssetPrice(cacheKey, assetCode, issuer);
  }

  /**
   * Invalidate market data cache
   */
  async invalidateMarketCache(assetCode?: string): Promise<number> {
    if (assetCode) {
      return this.cacheService.invalidateByPattern(
        assetCode,
        CacheNamespace.PRICE_DATA,
      );
    }
    return this.cacheService.invalidateNamespace(
      CacheNamespace.MARKET_SNAPSHOT,
    );
  }

  // =========================================================================
  // CIRCUIT BREAKER
  // =========================================================================

  /**
   * Record a successful Horizon call — resets failure counter.
   */
  private recordSuccess(): void {
    this.failureCount = 0;
    if (this.circuitState !== CircuitState.CLOSED) {
      this.logger.log('Circuit breaker: CLOSED (recovered)');
    }
    this.circuitState = CircuitState.CLOSED;
    this.openedAt = null;
  }

  /**
   * Record a failed Horizon call — opens circuit after threshold.
   */
  private recordFailure(): void {
    this.failureCount++;
    this.logger.warn(
      `Circuit breaker: failure #${this.failureCount}/${CIRCUIT_OPEN_AFTER_FAILURES}`,
    );
    if (this.failureCount >= CIRCUIT_OPEN_AFTER_FAILURES) {
      this.circuitState = CircuitState.OPEN;
      this.openedAt = Date.now();
      this.logger.error(
        `Circuit breaker OPEN — Horizon calls blocked for ${CIRCUIT_RESET_AFTER_MS / 1000}s`,
      );
    }
  }

  /**
   * Check if the circuit is currently allowing calls.
   */
  private isCircuitOpen(): boolean {
    if (this.circuitState === CircuitState.CLOSED) return false;
    if (this.circuitState === CircuitState.OPEN && this.openedAt) {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed > CIRCUIT_RESET_AFTER_MS) {
        this.circuitState = CircuitState.HALF_OPEN;
        this.logger.log('Circuit breaker: HALF_OPEN (probing Horizon)');
        return false; // Allow one probe call
      }
    }
    return this.circuitState === CircuitState.OPEN;
  }

  // =========================================================================
  // INTERNAL FETCHERS
  // =========================================================================

  private async fetchAndCacheSnapshot(
    cacheKey: string,
    assetFilter?: string[],
    bypassCache = false,
  ): Promise<MarketSnapshotDto> {
    if (this.isCircuitOpen()) {
      this.logger.warn('Circuit open — returning last-known-good or fallback');
      return this.getFallbackSnapshot(assetFilter);
    }

    try {
      const snapshot = await this.fetchMarketSnapshot(assetFilter);
      this.recordSuccess();

      // Cache and save last-known-good
      await Promise.all([
        this.cacheService.set(
          cacheKey,
          snapshot,
          CacheNamespace.MARKET_SNAPSHOT,
        ),
        this.cacheService.setLastKnownGood(
          cacheKey,
          CacheNamespace.MARKET_SNAPSHOT,
          snapshot,
        ),
      ]);

      return { ...snapshot, cached: false, dataFreshness: 'fresh' };
    } catch (error) {
      this.recordFailure();
      this.logger.error(`Failed to fetch market snapshot: ${error.message}`);
      return this.getFallbackSnapshot(assetFilter);
    }
  }

  private async fetchAndCacheAssetPrice(
    cacheKey: string,
    assetCode: string,
    issuer: string,
  ): Promise<AssetPriceDto | null> {
    if (this.isCircuitOpen()) {
      this.logger.warn(
        `Circuit open — returning last-known-good for ${assetCode}`,
      );
      return this.cacheService.getLastKnownGood<AssetPriceDto>(
        cacheKey,
        CacheNamespace.PRICE_DATA,
      );
    }

    try {
      const priceData = await this.fetchAssetPrice(assetCode, issuer);
      this.recordSuccess();

      if (priceData) {
        await Promise.all([
          this.cacheService.set(cacheKey, priceData, CacheNamespace.PRICE_DATA),
          this.cacheService.setLastKnownGood(
            cacheKey,
            CacheNamespace.PRICE_DATA,
            priceData,
          ),
        ]);
      }
      return priceData;
    } catch (error) {
      this.recordFailure();
      this.logger.error(`Failed to fetch ${assetCode} price: ${error.message}`);
      return this.cacheService.getLastKnownGood<AssetPriceDto>(
        cacheKey,
        CacheNamespace.PRICE_DATA,
      );
    }
  }

  private backgroundRefreshSnapshot(
    cacheKey: string,
    assetFilter?: string[],
  ): void {
    if (refreshLocks.get(cacheKey)) return; // Prevent stampede
    refreshLocks.set(cacheKey, true);

    setImmediate(async () => {
      try {
        await this.fetchAndCacheSnapshot(cacheKey, assetFilter);
        this.logger.debug(`Background refresh completed: ${cacheKey}`);
      } catch (err) {
        this.logger.error(`Background refresh failed: ${err.message}`);
      } finally {
        refreshLocks.delete(cacheKey);
      }
    });
  }

  private backgroundRefreshAssetPrice(
    cacheKey: string,
    assetCode: string,
    issuer: string,
  ): void {
    if (refreshLocks.get(cacheKey)) return;
    refreshLocks.set(cacheKey, true);

    setImmediate(async () => {
      try {
        await this.fetchAndCacheAssetPrice(cacheKey, assetCode, issuer);
        this.logger.debug(`Background price refresh completed: ${assetCode}`);
      } catch (err) {
        this.logger.error(`Background price refresh failed: ${err.message}`);
      } finally {
        refreshLocks.delete(cacheKey);
      }
    });
  }

  // =========================================================================
  // REAL HORIZON DATA FETCHING
  // =========================================================================

  /**
   * Fetch real market snapshot from Stellar Horizon DEX.
   * Derives price by examining orderbook mid-price (vs USDC), then
   * trade aggregation volume/change24h.
   */
  private async fetchMarketSnapshot(
    assetFilter?: string[],
  ): Promise<MarketSnapshotDto> {
    const assets =
      assetFilter && assetFilter.length > 0
        ? TOP_ASSETS.filter((a) => assetFilter.includes(a.code.toUpperCase()))
        : TOP_ASSETS;

    const priceResults = await Promise.allSettled(
      assets.map((a) => this.fetchAssetPrice(a.code, a.issuer)),
    );

    const resolvedAssets: AssetPriceDto[] = priceResults.map((r, i) => {
      if (r.status === 'fulfilled' && r.value) return r.value;
      // Single asset failed — use hardcoded default as individual fallback
      this.logger.warn(
        `Could not fetch price for ${assets[i].code}, using last-known or 0`,
      );
      return {
        code: assets[i].code,
        issuer: assets[i].issuer,
        priceUSD: 0,
        change24h: 0,
        volume24h: 0,
        marketCap: 0,
        dataFreshness: 'unavailable',
        source: 'Horizon (partial failure)',
      } as AssetPriceDto;
    });

    return {
      assets: resolvedAssets,
      timestamp: new Date(),
      source: 'Stellar Horizon DEX',
      cached: false,
      dataFreshness: 'fresh',
    };
  }

  /**
   * Fetch single asset price from Stellar Horizon DEX.
   * Derives USD price by looking at XLM/USDC orderbook mid-price,
   * then computing the asset price in terms of USDC.
   */
  private async fetchAssetPrice(
    assetCode: string,
    issuer: string,
  ): Promise<AssetPriceDto | null> {
    try {
      // For USDC, price is stable at ~1.0
      if (assetCode === 'USDC') {
        return this.buildUsdcPrice(issuer);
      }

      // For all other assets: get orderbook vs USDC
      const usdcIssuer =
        'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

      const orderbook = await this.horizonProvider.getOrderbook(
        assetCode,
        issuer,
        'USDC',
        usdcIssuer,
      );

      let priceUSD = 0;
      if (orderbook.bids?.length > 0 && orderbook.asks?.length > 0) {
        const bestBid = parseFloat(orderbook.bids[0].price);
        const bestAsk = parseFloat(orderbook.asks[0].price);
        priceUSD = (bestBid + bestAsk) / 2;
      } else if (orderbook.bids?.length > 0) {
        priceUSD = parseFloat(orderbook.bids[0].price);
      } else if (orderbook.asks?.length > 0) {
        priceUSD = parseFloat(orderbook.asks[0].price);
      }

      // Get 24h trade aggregation for volume and change
      let change24h = 0;
      let volume24h = 0;
      try {
        const trades = await this.horizonProvider.getRecentTrades(
          assetCode,
          issuer,
          'USDC',
          usdcIssuer,
          24,
        );
        if (trades.records?.length > 0) {
          volume24h = trades.records.reduce(
            (sum: number, t: any) => sum + parseFloat(t.base_volume || '0'),
            0,
          );
          // Change24h: compare first (oldest) vs last (newest) close price
          const oldest = trades.records[trades.records.length - 1];
          const newest = trades.records[0];
          if (oldest && newest && parseFloat(oldest.close) !== 0) {
            change24h =
              ((parseFloat(newest.close) - parseFloat(oldest.close)) /
                parseFloat(oldest.close)) *
              100;
          }
        }
      } catch (tradeError) {
        this.logger.warn(
          `Trade aggregation failed for ${assetCode}: ${tradeError.message}`,
        );
      }

      return {
        code: assetCode,
        issuer,
        priceUSD,
        change24h: parseFloat(change24h.toFixed(4)),
        volume24h: parseFloat(volume24h.toFixed(2)),
        marketCap: 0, // Not available from Horizon directly
        dataFreshness: 'fresh',
        source: 'Stellar Horizon DEX',
      };
    } catch (error) {
      this.logger.error(
        `Error fetching ${assetCode} from Horizon: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  private buildUsdcPrice(issuer: string): AssetPriceDto {
    return {
      code: 'USDC',
      issuer,
      priceUSD: 1.0,
      change24h: 0,
      volume24h: 0,
      marketCap: 0,
      dataFreshness: 'fresh',
      source: 'Stellar Horizon DEX (stable)',
    };
  }

  // =========================================================================
  // FALLBACK
  // =========================================================================

  private async getFallbackSnapshot(
    assetFilter?: string[],
  ): Promise<MarketSnapshotDto> {
    // Try last-known-good from Redis
    const lkgKey = this.generateMarketSnapshotKey(assetFilter);
    const lkg = await this.cacheService.getLastKnownGood<MarketSnapshotDto>(
      lkgKey,
      CacheNamespace.MARKET_SNAPSHOT,
    );
    if (lkg) {
      this.logger.warn('Returning last-known-good market snapshot');
      return {
        ...lkg,
        dataFreshness: 'last_known_good',
        cached: true,
        timestamp: new Date(),
      };
    }

    // Absolute last resort: hardcoded static data
    this.logger.warn('No LKG data — returning hardcoded fallback');
    const fallbackAssets =
      assetFilter && assetFilter.length > 0
        ? HARDCODED_FALLBACK.filter((a) =>
            assetFilter.includes(a.code.toUpperCase()),
          )
        : HARDCODED_FALLBACK;

    return {
      assets: fallbackAssets,
      timestamp: new Date(),
      source: 'Hardcoded fallback',
      cached: false,
      dataFreshness: 'hardcoded_fallback',
    };
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  private generateMarketSnapshotKey(assetFilter?: string[]): string {
    if (!assetFilter || assetFilter.length === 0) return 'all-assets';
    return `assets:${assetFilter.sort().join(',')}`;
  }
}
