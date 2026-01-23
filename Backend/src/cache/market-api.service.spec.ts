import { Test, TestingModule } from '@nestjs/testing';
import { MarketApiService } from './market-api.service';
import { MarketCacheService } from './market-cache.service';

describe('MarketApiService', () => {
  let service: MarketApiService;
  let marketCacheService: MarketCacheService;

  beforeEach(async () => {
    const mockMarketCacheService = {
      getMarketSnapshot: jest.fn(),
      getExtendedMarketData: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketApiService,
        {
          provide: MarketCacheService,
          useValue: mockMarketCacheService,
        },
      ],
    }).compile();

    service = module.get<MarketApiService>(MarketApiService);
    marketCacheService = module.get<MarketCacheService>(MarketCacheService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getMarketSnapshot', () => {
    it('should return market snapshot data', async () => {
      const assetId = 'USD-STELLARA';
      const mockSnapshot = {
        assetId,
        price: 100.5,
        volume24h: 1000000,
        marketCap: 1000000000,
        priceChange24h: -2.5,
        timestamp: new Date(),
      };

      (marketCacheService.getMarketSnapshot as jest.Mock).mockResolvedValue(
        mockSnapshot,
      );

      const result = await service.getMarketSnapshot(assetId);

      expect(result).toEqual(mockSnapshot);
      expect(marketCacheService.getMarketSnapshot).toHaveBeenCalledWith(
        assetId,
        expect.any(Function),
      );
    });

    it('should call cache service with provider function', async () => {
      const assetId = 'USD-STELLARA';
      const mockSnapshot = {
        assetId,
        price: 100.5,
        volume24h: 1000000,
        marketCap: 1000000000,
        priceChange24h: -2.5,
        timestamp: new Date(),
      };

      (marketCacheService.getMarketSnapshot as jest.Mock).mockImplementation(
        async (id, provider) => provider(),
      );

      const result = await service.getMarketSnapshot(assetId);

      expect(result.assetId).toBe(assetId);
      expect(result).toHaveProperty('price');
      expect(result).toHaveProperty('volume24h');
    });
  });

  describe('getExtendedMarketData', () => {
    it('should return extended market data with technical indicators', async () => {
      const assetId = 'USD-STELLARA';
      const mockData = {
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

      (marketCacheService.getExtendedMarketData as jest.Mock).mockResolvedValue(
        mockData,
      );

      const result = await service.getExtendedMarketData(assetId);

      expect(result).toEqual(mockData);
      expect(result).toHaveProperty('rsi');
      expect(result).toHaveProperty('macd');
      expect(result).toHaveProperty('bollingerBands');
      expect(result).toHaveProperty('movingAverages');
    });

    it('should call cache service with correct provider', async () => {
      const assetId = 'USD-STELLARA';

      (marketCacheService.getExtendedMarketData as jest.Mock).mockImplementation(
        async (id, provider) => provider(),
      );

      const result = await service.getExtendedMarketData(assetId);

      expect(result.assetId).toBe(assetId);
      expect(result).toHaveProperty('rsi');
    });
  });
});
