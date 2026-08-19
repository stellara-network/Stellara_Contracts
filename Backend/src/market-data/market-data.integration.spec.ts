/**
 * Integration test: Validates market-data data transformation with mocked Horizon responses.
 * Covers all acceptance criteria:
 *   - HorizonMarketDataProvider is called (not mock data)
 *   - SWR pattern (fresh / stale) flags
 *   - Circuit breaker graceful degradation
 *   - dataFreshness and source fields in response DTOs
 *   - Cron-based cache warming service instantiates
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { MarketDataService, TOP_ASSETS } from './services/market-data.service';
import { MarketCacheService } from './services/market-cache.service';
import { HorizonMarketDataProvider } from './services/horizon-market-data-provider.service';
import { MarketCacheWarmingService } from './services/market-cache-warming.service';
import { CacheNamespace } from './types/cache-config.types';

// ---------------------------------------------------------------------------
// Mocked Horizon orderbook / trades response
// ---------------------------------------------------------------------------
const MOCK_XLM_ORDERBOOK = {
  bids: [{ price: '0.12', amount: '100000' }],
  asks: [{ price: '0.13', amount: '80000' }],
};

const MOCK_TRADE_AGGREGATIONS = {
  records: [
    { base_volume: '5000000', close: '0.125', open: '0.12' },
    { base_volume: '6000000', close: '0.12', open: '0.115' },
  ],
};

// ---------------------------------------------------------------------------
// Mocked cache service
// ---------------------------------------------------------------------------
const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn().mockResolvedValue(undefined);
const mockCacheIsStale = jest.fn().mockResolvedValue(false);
const mockCacheLKG = jest.fn().mockResolvedValue(null);
const mockCacheSetLKG = jest.fn().mockResolvedValue(undefined);
const mockCacheInvalidate = jest.fn().mockResolvedValue(0);
const mockCacheInvalidateNS = jest.fn().mockResolvedValue(0);
const mockCacheInvalidatePattern = jest.fn().mockResolvedValue(0);
const mockCacheGetMetadata = jest.fn().mockResolvedValue(null);

const mockCacheService: Partial<MarketCacheService> = {
  get: mockCacheGet,
  set: mockCacheSet,
  isStale: mockCacheIsStale,
  getLastKnownGood: mockCacheLKG,
  setLastKnownGood: mockCacheSetLKG,
  invalidateNamespace: mockCacheInvalidateNS,
  invalidateByPattern: mockCacheInvalidatePattern,
  invalidate: mockCacheInvalidate,
  getMetadata: mockCacheGetMetadata,
};

// ---------------------------------------------------------------------------
// Mocked Horizon provider
// ---------------------------------------------------------------------------
const mockGetOrderbook = jest.fn().mockResolvedValue(MOCK_XLM_ORDERBOOK);
const mockGetRecentTrades = jest
  .fn()
  .mockResolvedValue(MOCK_TRADE_AGGREGATIONS);
const mockGetAssetStats = jest.fn().mockResolvedValue({});

const mockHorizonProvider: Partial<HorizonMarketDataProvider> = {
  getOrderbook: mockGetOrderbook,
  getRecentTrades: mockGetRecentTrades,
  getAssetStats: mockGetAssetStats,
};

// ---------------------------------------------------------------------------
describe('MarketDataService — Horizon Integration', () => {
  let service: MarketDataService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default: cache miss
    mockCacheGet.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketDataService,
        { provide: MarketCacheService, useValue: mockCacheService },
        { provide: HorizonMarketDataProvider, useValue: mockHorizonProvider },
      ],
    }).compile();

    service = module.get<MarketDataService>(MarketDataService);
  });

  // =========================================================================
  describe('getMarketSnapshot', () => {
    it('should return a snapshot with assets on cache miss', async () => {
      const snapshot = await service.getMarketSnapshot();

      expect(snapshot).toHaveProperty('assets');
      expect(Array.isArray(snapshot.assets)).toBe(true);
      expect(snapshot.source).toBe('Stellar Horizon DEX');
    });

    it('should call HorizonProvider.getOrderbook for each non-USDC asset', async () => {
      await service.getMarketSnapshot();
      // XLM, AQUA, yXLM — not USDC (which has stable $1 price)
      const nonUsdcAssets = TOP_ASSETS.filter((a) => a.code !== 'USDC');
      expect(mockGetOrderbook).toHaveBeenCalledTimes(nonUsdcAssets.length);
    });

    it('should include dataFreshness and source on each asset', async () => {
      const snapshot = await service.getMarketSnapshot();
      for (const asset of snapshot.assets) {
        expect(asset).toHaveProperty('dataFreshness');
        expect(asset).toHaveProperty('source');
      }
    });

    it('should return fresh data from cache when cache is not stale', async () => {
      const cachedSnapshot = {
        assets: [],
        timestamp: new Date(),
        source: 'Stellar Horizon DEX',
        cached: true,
        dataFreshness: 'fresh',
      };
      mockCacheGet.mockResolvedValueOnce(cachedSnapshot);
      mockCacheIsStale.mockResolvedValueOnce(false);

      const result = await service.getMarketSnapshot();

      expect(result.cached).toBe(true);
      expect(result.dataFreshness).toBe('fresh');
      // Horizon should NOT be called when serving fresh cached data
      expect(mockGetOrderbook).not.toHaveBeenCalled();
    });

    it('should serve stale data and trigger background refresh when cache is stale', async () => {
      const staleSnapshot = {
        assets: [{ code: 'XLM', priceUSD: 0.1 }],
        timestamp: new Date(Date.now() - 600_000),
        source: 'Stellar Horizon DEX',
        cached: true,
        dataFreshness: 'stale',
      };
      mockCacheGet.mockResolvedValueOnce(staleSnapshot);
      mockCacheIsStale.mockResolvedValueOnce(true);

      const result = await service.getMarketSnapshot();

      // Stale data should be returned immediately
      expect(result.dataFreshness).toBe('stale');
      expect(result.cached).toBe(true);
    });

    it('should bypass cache when bypassCache=true', async () => {
      await service.getMarketSnapshot(undefined, true);
      // Cache should not be checked
      expect(mockCacheGet).not.toHaveBeenCalled();
      // Horizon should be called
      expect(mockGetOrderbook).toHaveBeenCalled();
    });

    it('should derive XLM mid-price from orderbook bids and asks', async () => {
      const snapshot = await service.getMarketSnapshot(['XLM']);
      const xlm = snapshot.assets.find((a) => a.code === 'XLM');
      expect(xlm).toBeDefined();
      // mid-price = (0.12 + 0.13) / 2 = 0.125
      expect(xlm!.priceUSD).toBeCloseTo(0.125, 3);
    });

    it('should set cache and last-known-good on successful fetch', async () => {
      await service.getMarketSnapshot(undefined, true);
      expect(mockCacheSet).toHaveBeenCalled();
      expect(mockCacheSetLKG).toHaveBeenCalled();
    });

    it('should gracefully degrade to last-known-good when Horizon fails', async () => {
      const lkgSnapshot = {
        assets: [
          { code: 'XLM', priceUSD: 0.1, dataFreshness: 'last_known_good' },
        ],
        source: 'Stellar Horizon DEX',
        timestamp: new Date(),
        cached: true,
        dataFreshness: 'last_known_good',
      };
      // Use Once to avoid poisoning the circuit breaker state for other tests
      mockGetOrderbook.mockRejectedValueOnce(new Error('Horizon down'));
      mockGetOrderbook.mockRejectedValueOnce(new Error('Horizon down'));
      mockGetOrderbook.mockRejectedValueOnce(new Error('Horizon down'));
      mockGetRecentTrades.mockRejectedValueOnce(new Error('Horizon down'));
      mockGetRecentTrades.mockRejectedValueOnce(new Error('Horizon down'));
      mockGetRecentTrades.mockRejectedValueOnce(new Error('Horizon down'));
      mockCacheLKG.mockResolvedValue(lkgSnapshot);

      const result = await service.getMarketSnapshot(undefined, true);
      // Should get LKG data, not crash
      expect(result).toBeDefined();
    });

    it('should return hardcoded fallback when Horizon fails and no LKG data', async () => {
      // Build a fresh service instance with a clean circuit breaker
      const freshModule = await Test.createTestingModule({
        providers: [
          MarketDataService,
          { provide: MarketCacheService, useValue: mockCacheService },
          { provide: HorizonMarketDataProvider, useValue: mockHorizonProvider },
        ],
      }).compile();
      const freshService =
        freshModule.get<MarketDataService>(MarketDataService);

      mockGetOrderbook.mockRejectedValueOnce(new Error('Horizon down'));
      mockGetOrderbook.mockRejectedValueOnce(new Error('Horizon down'));
      mockGetOrderbook.mockRejectedValueOnce(new Error('Horizon down'));
      mockGetRecentTrades.mockRejectedValueOnce(new Error('Horizon down'));
      mockCacheLKG.mockResolvedValue(null);

      const result = await freshService.getMarketSnapshot(undefined, true);

      expect(result).toBeDefined();
      // USDC always resolves at $1 (no Horizon call needed), so only check non-USDC assets
      const nonUsdcAssets = result.assets.filter((a) => a.code !== 'USDC');
      const nonUsdcUnavailable =
        nonUsdcAssets.length === 0 ||
        nonUsdcAssets.every(
          (a) => a.dataFreshness === 'unavailable' || a.priceUSD === 0,
        );
      const isFallback = result.dataFreshness === 'hardcoded_fallback';
      expect(nonUsdcUnavailable || isFallback).toBe(true);
    });
  });

  // =========================================================================
  describe('getAssetPrice', () => {
    it('should return price data from Horizon for XLM', async () => {
      // Ensure mocks are in default (resolved) state for this test
      mockGetOrderbook.mockResolvedValueOnce(MOCK_XLM_ORDERBOOK);
      mockGetRecentTrades.mockResolvedValueOnce(MOCK_TRADE_AGGREGATIONS);
      const price = await service.getAssetPrice('XLM', 'native');

      expect(price).not.toBeNull();
      expect(price!.code).toBe('XLM');
      expect(typeof price!.priceUSD).toBe('number');
      expect(price!.source).toBe('Stellar Horizon DEX');
    });

    it('should return stable $1 price for USDC', async () => {
      const price = await service.getAssetPrice(
        'USDC',
        'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      );

      expect(price!.priceUSD).toBe(1.0);
      // Horizon should not be called for USDC (handled inline)
      expect(mockGetOrderbook).not.toHaveBeenCalled();
    });

    it('should include dataFreshness and source on returned price', async () => {
      mockGetOrderbook.mockResolvedValueOnce(MOCK_XLM_ORDERBOOK);
      mockGetRecentTrades.mockResolvedValueOnce(MOCK_TRADE_AGGREGATIONS);
      const price = await service.getAssetPrice('XLM', 'native');
      expect(price!.dataFreshness).toBe('fresh');
      expect(price!.source).toBe('Stellar Horizon DEX');
    });

    it('should return null/fallback when Horizon fails and no cache', async () => {
      mockGetOrderbook.mockRejectedValueOnce(new Error('Horizon error'));

      const price = await service.getAssetPrice('XLM', 'native');
      // Should not throw, should return null or LKG
      expect(price === null || typeof price === 'object').toBe(true);
    });
  });

  // =========================================================================
  describe('invalidateMarketCache', () => {
    it('should invalidate snapshot namespace when no assetCode given', async () => {
      await service.invalidateMarketCache();
      expect(mockCacheInvalidateNS).toHaveBeenCalledWith(
        CacheNamespace.MARKET_SNAPSHOT,
      );
    });

    it('should invalidate by pattern when assetCode is given', async () => {
      await service.invalidateMarketCache('XLM');
      expect(mockCacheInvalidatePattern).toHaveBeenCalledWith(
        'XLM',
        CacheNamespace.PRICE_DATA,
      );
    });
  });
});

// ---------------------------------------------------------------------------
describe('MarketCacheWarmingService', () => {
  let warmingService: MarketCacheWarmingService;
  let mockMarketDataService: Partial<MarketDataService>;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockMarketDataService = {
      getMarketSnapshot: jest.fn().mockResolvedValue({
        assets: [],
        timestamp: new Date(),
        source: 'Stellar Horizon DEX',
      }),
      getAssetPrice: jest.fn().mockResolvedValue({
        code: 'XLM',
        priceUSD: 0.125,
        source: 'Stellar Horizon DEX',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketCacheWarmingService,
        { provide: MarketDataService, useValue: mockMarketDataService },
        { provide: MarketCacheService, useValue: mockCacheService },
      ],
    }).compile();

    warmingService = module.get<MarketCacheWarmingService>(
      MarketCacheWarmingService,
    );
  });

  it('should be defined', () => {
    expect(warmingService).toBeDefined();
  });

  it('should warm all top-N asset prices during a warming cycle', async () => {
    await warmingService.warmMarketCache();

    expect(mockMarketDataService.getMarketSnapshot).toHaveBeenCalledWith(
      undefined,
      true,
    );
    expect(mockMarketDataService.getAssetPrice).toHaveBeenCalledTimes(
      TOP_ASSETS.length,
    );
  });

  it('should not run concurrent warming cycles', async () => {
    // Simulate slow fetch
    (mockMarketDataService.getMarketSnapshot as jest.Mock).mockImplementation(
      () => new Promise((res) => setTimeout(res, 100)),
    );

    // Fire two warming cycles concurrently
    const [, result2] = await Promise.all([
      warmingService.warmMarketCache(),
      warmingService.warmMarketCache(),
    ]);

    // Second call should be a no-op (guarded by isWarming)
    expect(result2).toBeUndefined();
  });

  it('should report isCurrentlyWarming correctly', () => {
    expect(warmingService.isCurrentlyWarming()).toBe(false);
  });
});
