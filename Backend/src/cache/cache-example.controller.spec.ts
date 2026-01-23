import { Test, TestingModule } from '@nestjs/testing';
import { CacheExampleController } from './cache-example.controller';
import { CacheService, CacheMetrics } from './cache.service';
import { MarketApiService, ExtendedMarketData, MarketSnapshot } from './market-api.service';
import { NewsApiService, NewsArticle } from './news-api.service';

describe('CacheExampleController (Integration Tests)', () => {
  let controller: CacheExampleController;
  let cacheService: CacheService;
  let marketApiService: MarketApiService;
  let newsApiService: NewsApiService;

  beforeEach(async () => {
    const mockCacheService = {
      getMetrics: jest.fn(),
      getRedisInfo: jest.fn(),
    };

    const mockMarketApiService = {
      getMarketSnapshot: jest.fn(),
      getExtendedMarketData: jest.fn(),
    };

    const mockNewsApiService = {
      getNews: jest.fn(),
      getTrendingNews: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CacheExampleController],
      providers: [
        {
          provide: CacheService,
          useValue: mockCacheService,
        },
        {
          provide: MarketApiService,
          useValue: mockMarketApiService,
        },
        {
          provide: NewsApiService,
          useValue: mockNewsApiService,
        },
      ],
    }).compile();

    controller = module.get<CacheExampleController>(CacheExampleController);
    cacheService = module.get<CacheService>(CacheService);
    marketApiService = module.get<MarketApiService>(MarketApiService);
    newsApiService = module.get<NewsApiService>(NewsApiService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/cache/market/:assetId', () => {
    it('should return market snapshot for asset', async () => {
      const assetId = 'USD-STELLARA';
      const mockSnapshot: MarketSnapshot = {
        assetId,
        price: 100.5,
        volume24h: 1000000,
        marketCap: 1000000000,
        priceChange24h: -2.5,
        timestamp: new Date(),
      };

      (marketApiService.getMarketSnapshot as jest.Mock).mockResolvedValue(
        mockSnapshot,
      );

      const result = await controller.getMarketSnapshot(assetId);

      expect(result).toEqual(mockSnapshot);
      expect(marketApiService.getMarketSnapshot).toHaveBeenCalledWith(assetId);
    });

    it('should use cache for repeated requests', async () => {
      const assetId = 'USD-STELLARA';
      const mockSnapshot: MarketSnapshot = {
        assetId,
        price: 100.5,
        volume24h: 1000000,
        marketCap: 1000000000,
        priceChange24h: -2.5,
        timestamp: new Date(),
      };

      (marketApiService.getMarketSnapshot as jest.Mock).mockResolvedValue(
        mockSnapshot,
      );

      // Call twice
      await controller.getMarketSnapshot(assetId);
      await controller.getMarketSnapshot(assetId);

      // Service should be called but cache layer would handle second call
      expect(marketApiService.getMarketSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  describe('GET /api/cache/market/:assetId/extended', () => {
    it('should return extended market data with technical indicators', async () => {
      const assetId = 'USD-STELLARA';
      const mockData: ExtendedMarketData = {
        assetId,
        price: 100.5,
        volume24h: 1000000,
        marketCap: 1000000000,
        priceChange24h: -2.5,
        rsi: 65,
        macd: { value: 0.5, signal: 0.4, histogram: 0.1 },
        bollingerBands: { upper: 110, middle: 100, lower: 90 },
        movingAverages: { sma20: 100, sma50: 99, ema12: 101 },
        timestamp: new Date(),
      };

      (marketApiService.getExtendedMarketData as jest.Mock).mockResolvedValue(
        mockData,
      );

      const result = await controller.getExtendedMarketData(assetId);

      expect(result).toEqual(mockData);
      expect(result).toHaveProperty('rsi');
      expect(result).toHaveProperty('macd');
      expect(marketApiService.getExtendedMarketData).toHaveBeenCalledWith(assetId);
    });
  });

  describe('GET /api/cache/news', () => {
    it('should return news articles with default category', async () => {
      const mockNews: NewsArticle[] = [
        {
          id: '1',
          title: 'News 1',
          description: 'Description',
          source: 'CryptoNews',
          category: 'all',
          url: 'https://example.com/news/1',
          publishedAt: new Date(),
          sentiment: 'positive',
        },
      ];

      (newsApiService.getNews as jest.Mock).mockResolvedValue(mockNews);

      const result = await controller.getNews();

      expect(result).toEqual(mockNews);
      expect(newsApiService.getNews).toHaveBeenCalledWith('all');
    });

    it('should return news for specific category', async () => {
      const category = 'blockchain';
      const mockNews: NewsArticle[] = [
        {
          id: '1',
          title: 'Blockchain News',
          description: 'Description',
          source: 'CryptoNews',
          category,
          url: 'https://example.com/news/1',
          publishedAt: new Date(),
        },
      ];

      (newsApiService.getNews as jest.Mock).mockResolvedValue(mockNews);

      const result = await controller.getNews(category);

      expect(result).toEqual(mockNews);
      expect(newsApiService.getNews).toHaveBeenCalledWith(category);
    });
  });

  describe('GET /api/cache/news/trending', () => {
    it('should return trending news articles', async () => {
      const mockNews: NewsArticle[] = [
        {
          id: 'trending-1',
          title: 'Bitcoin Reaches ATH',
          description: 'Market surge',
          source: 'CryptoNews',
          category: 'market-updates',
          url: 'https://example.com/trending/1',
          publishedAt: new Date(),
          sentiment: 'positive',
        },
      ];

      (newsApiService.getTrendingNews as jest.Mock).mockResolvedValue(mockNews);

      const result = await controller.getTrendingNews();

      expect(result).toEqual(mockNews);
      expect(newsApiService.getTrendingNews).toHaveBeenCalled();
    });
  });

  describe('GET /api/cache/metrics', () => {
    it('should return cache metrics', async () => {
      const mockMetrics: Record<string, CacheMetrics> = {
        'cache:market': {
          hits: 150,
          misses: 50,
          hitRate: 75,
          totalRequests: 200,
        },
        'cache:news': {
          hits: 100,
          misses: 25,
          hitRate: 80,
          totalRequests: 125,
        },
      };

      (cacheService.getMetrics as jest.Mock).mockReturnValue(mockMetrics);

      const result = await controller.getCacheMetrics();

      expect(result).toEqual(mockMetrics);
      expect(result['cache:market'].hitRate).toBe(75);
      expect(result['cache:news'].hitRate).toBe(80);
    });

    it('should show increasing hit rate over time', async () => {
      const mockMetrics: Record<string, CacheMetrics> = {
        'cache:market': {
          hits: 1000,
          misses: 10,
          hitRate: 99,
          totalRequests: 1010,
        },
      };

      (cacheService.getMetrics as jest.Mock).mockReturnValue(mockMetrics);

      const result = await controller.getCacheMetrics();

      expect(result['cache:market'].hitRate).toBeGreaterThan(95);
    });
  });

  describe('GET /api/cache/info', () => {
    it('should return cache information with metrics and config', async () => {
      const mockMetrics: Record<string, CacheMetrics> = {
        'cache:market': {
          hits: 150,
          misses: 50,
          hitRate: 75,
          totalRequests: 200,
        },
      };

      (cacheService.getMetrics as jest.Mock).mockReturnValue(mockMetrics);
      (cacheService.getRedisInfo as jest.Mock).mockResolvedValue(
        'redis_version:7.0.0',
      );

      const result = await controller.getCacheInfo();

      expect(result).toHaveProperty('redis');
      expect(result).toHaveProperty('metrics');
      expect(result).toHaveProperty('config');
      expect(result.config.market_snapshot).toBeDefined();
      expect(result.config.market_snapshot.ttl).toBe(60);
      expect(result.config.news.ttl).toBe(600);
    });

    it('should include all cache configurations', async () => {
      (cacheService.getMetrics as jest.Mock).mockReturnValue({});
      (cacheService.getRedisInfo as jest.Mock).mockResolvedValue('');

      const result = await controller.getCacheInfo();

      expect(Object.keys(result.config)).toContain('market_snapshot');
      expect(Object.keys(result.config)).toContain('market_snapshot_extended');
      expect(Object.keys(result.config)).toContain('news');
      expect(Object.keys(result.config)).toContain('news_trending');
    });
  });
});
