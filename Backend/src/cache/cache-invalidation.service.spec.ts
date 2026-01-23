import { Test, TestingModule } from '@nestjs/testing';
import {
  CacheInvalidationService,
  AssetUpdatedEvent,
  NewsUpdatedEvent,
} from './cache-invalidation.service';
import { CacheService } from './cache.service';
import { MarketCacheService } from './market-cache.service';
import { NewsCacheService } from './news-cache.service';

describe('CacheInvalidationService', () => {
  let service: CacheInvalidationService;
  let cacheService: CacheService;
  let marketCacheService: MarketCacheService;
  let newsCacheService: NewsCacheService;

  beforeEach(async () => {
    const mockCacheService = {
      delete: jest.fn(),
      deleteByPattern: jest.fn(),
    };

    const mockMarketCacheService = {
      invalidateMarketCache: jest.fn(),
    };

    const mockNewsCacheService = {
      invalidateNewsCache: jest.fn(),
      invalidateNewsCategoryCache: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CacheInvalidationService,
        {
          provide: CacheService,
          useValue: mockCacheService,
        },
        {
          provide: MarketCacheService,
          useValue: mockMarketCacheService,
        },
        {
          provide: NewsCacheService,
          useValue: mockNewsCacheService,
        },
      ],
    }).compile();

    service = module.get<CacheInvalidationService>(CacheInvalidationService);
    cacheService = module.get<CacheService>(CacheService);
    marketCacheService = module.get<MarketCacheService>(MarketCacheService);
    newsCacheService = module.get<NewsCacheService>(NewsCacheService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('emitAssetUpdated', () => {
    it('should emit asset updated event with default type', async () => {
      const assetId = 'USD-STELLARA';

      await service.emitAssetUpdated(assetId);

      expect(marketCacheService.invalidateMarketCache).toHaveBeenCalledWith(
        assetId,
      );
    });

    it('should emit asset updated event with specific type', async () => {
      const assetId = 'USD-STELLARA';
      const type = 'price' as const;

      await service.emitAssetUpdated(assetId, type);

      expect(marketCacheService.invalidateMarketCache).toHaveBeenCalledWith(
        assetId,
      );
    });
  });

  describe('emitNewsUpdated', () => {
    it('should emit news updated event', async () => {
      const category = 'blockchain';

      await service.emitNewsUpdated(category, false);

      expect(newsCacheService.invalidateNewsCategoryCache).toHaveBeenCalledWith(
        category,
      );
    });
  });

  describe('handleAssetUpdated (via emit)', () => {
    it('should invalidate market cache on asset price update', async () => {
      const assetId = 'USD-STELLARA';

      await service.emitAssetUpdated(assetId, 'price');

      expect(marketCacheService.invalidateMarketCache).toHaveBeenCalledWith(
        assetId,
      );
    });

    it('should invalidate market cache on asset volume update', async () => {
      const assetId = 'USD-STELLARA';

      await service.emitAssetUpdated(assetId, 'volume');

      expect(marketCacheService.invalidateMarketCache).toHaveBeenCalledWith(
        assetId,
      );
    });

    it('should invalidate extended data on metadata update', async () => {
      const assetId = 'USD-STELLARA';

      await service.emitAssetUpdated(assetId, 'metadata');

      expect(cacheService.delete).toHaveBeenCalledWith(
        expect.stringContaining('extended'),
      );
    });

    it('should invalidate all asset caches on all type update', async () => {
      const assetId = 'USD-STELLARA';

      await service.emitAssetUpdated(assetId, 'all');

      expect(marketCacheService.invalidateMarketCache).toHaveBeenCalledWith(
        assetId,
      );
    });
  });

  describe('handleNewsUpdated (via emit)', () => {
    it('should invalidate all news cache when no category specified', async () => {
      await service.emitNewsUpdated();

      expect(newsCacheService.invalidateNewsCache).toHaveBeenCalled();
    });

    it('should invalidate specific category cache when category provided', async () => {
      const category = 'blockchain';

      await service.emitNewsUpdated(category);

      expect(newsCacheService.invalidateNewsCategoryCache).toHaveBeenCalledWith(
        category,
      );
    });

    it('should invalidate trending news cache when isTrending is true', async () => {
      await service.emitNewsUpdated('blockchain', true);

      expect(cacheService.delete).toHaveBeenCalledWith('cache:news:trending');
    });
  });

  describe('clearAllCaches', () => {
    it('should delete all caches', async () => {
      (cacheService.deleteByPattern as jest.Mock).mockResolvedValue(10);

      await service.clearAllCaches();

      expect(cacheService.deleteByPattern).toHaveBeenCalledWith('cache:market:*');
      expect(cacheService.deleteByPattern).toHaveBeenCalledWith('cache:news:*');
      expect(cacheService.deleteByPattern).toHaveBeenCalledWith('cache:metrics:*');
    });
  });

  describe('custom handlers', () => {
    it('should allow registering custom asset update handlers', async () => {
      const customHandler = jest.fn();
      service.onAssetUpdated(customHandler);

      const assetId = 'USD-STELLARA';
      await service.emitAssetUpdated(assetId, 'price');

      expect(customHandler).toHaveBeenCalled();
    });

    it('should allow registering custom news update handlers', async () => {
      const customHandler = jest.fn();
      service.onNewsUpdated(customHandler);

      await service.emitNewsUpdated('blockchain');

      expect(customHandler).toHaveBeenCalled();
    });
  });
});
