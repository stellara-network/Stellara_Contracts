import { Test, TestingModule } from '@nestjs/testing';
import { MarketCacheService } from './market-cache.service';
import { CacheService } from './cache.service';

describe('MarketCacheService', () => {
  let service: MarketCacheService;
  let cacheService: CacheService;

  beforeEach(async () => {
    const mockCacheService = {
      getOrSet: jest.fn(),
      delete: jest.fn(),
      deleteByPattern: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketCacheService,
        {
          provide: CacheService,
          useValue: mockCacheService,
        },
      ],
    }).compile();

    service = module.get<MarketCacheService>(MarketCacheService);
    cacheService = module.get<CacheService>(CacheService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getMarketSnapshot', () => {
    it('should get market snapshot with correct TTL', async () => {
      const assetId = 'USD-STELLARA';
      const snapshot = { price: 100, volume: 1000 };
      const provider = jest.fn().mockResolvedValue(snapshot);

      (cacheService.getOrSet as jest.Mock).mockResolvedValue(snapshot);

      const result = await service.getMarketSnapshot(assetId, provider);

      expect(result).toEqual(snapshot);
      expect(cacheService.getOrSet).toHaveBeenCalledWith(
        expect.stringContaining(assetId),
        provider,
        60, // TTL from config
      );
    });
  });

  describe('getExtendedMarketData', () => {
    it('should get extended market data with correct TTL', async () => {
      const assetId = 'USD-STELLARA';
      const data = {
        price: 100,
        rsi: 65,
        macd: { value: 0.5 },
      };
      const provider = jest.fn().mockResolvedValue(data);

      (cacheService.getOrSet as jest.Mock).mockResolvedValue(data);

      const result = await service.getExtendedMarketData(assetId, provider);

      expect(result).toEqual(data);
      expect(cacheService.getOrSet).toHaveBeenCalledWith(
        expect.stringContaining(assetId),
        provider,
        300, // Extended TTL from config
      );
    });
  });

  describe('invalidateMarketCache', () => {
    it('should invalidate both snapshot and extended market cache', async () => {
      const assetId = 'USD-STELLARA';

      await service.invalidateMarketCache(assetId);

      expect(cacheService.delete).toHaveBeenCalledTimes(2);
      expect(cacheService.delete).toHaveBeenCalledWith(
        expect.stringContaining(assetId),
      );
    });
  });
});
