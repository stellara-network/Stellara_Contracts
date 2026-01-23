import { Test, TestingModule } from '@nestjs/testing';
import { NewsCacheService } from './news-cache.service';
import { CacheService } from './cache.service';

describe('NewsCacheService', () => {
  let service: NewsCacheService;
  let cacheService: CacheService;

  beforeEach(async () => {
    const mockCacheService = {
      getOrSet: jest.fn(),
      delete: jest.fn(),
      deleteByPattern: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NewsCacheService,
        {
          provide: CacheService,
          useValue: mockCacheService,
        },
      ],
    }).compile();

    service = module.get<NewsCacheService>(NewsCacheService);
    cacheService = module.get<CacheService>(CacheService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getNews', () => {
    it('should get news with default category', async () => {
      const news = [{ id: 1, title: 'News 1' }];
      const provider = jest.fn().mockResolvedValue(news);

      (cacheService.getOrSet as jest.Mock).mockResolvedValue(news);

      const result = await service.getNews('all', provider);

      expect(result).toEqual(news);
      expect(cacheService.getOrSet).toHaveBeenCalledWith(
        expect.stringContaining('cache:news'),
        provider,
        600, // TTL from config
      );
    });

    it('should get news for specific category', async () => {
      const category = 'blockchain';
      const news = [{ id: 1, title: 'Blockchain News' }];
      const provider = jest.fn().mockResolvedValue(news);

      (cacheService.getOrSet as jest.Mock).mockResolvedValue(news);

      const result = await service.getNews(category, provider);

      expect(result).toEqual(news);
      expect(cacheService.getOrSet).toHaveBeenCalledWith(
        expect.stringContaining(category),
        provider,
        600,
      );
    });
  });

  describe('getTrendingNews', () => {
    it('should get trending news with correct TTL', async () => {
      const trendingNews = [{ id: 1, title: 'Trending' }];
      const provider = jest.fn().mockResolvedValue(trendingNews);

      (cacheService.getOrSet as jest.Mock).mockResolvedValue(trendingNews);

      const result = await service.getTrendingNews(provider);

      expect(result).toEqual(trendingNews);
      expect(cacheService.getOrSet).toHaveBeenCalledWith(
        expect.stringContaining('trending'),
        provider,
        300, // Trending TTL from config
      );
    });
  });

  describe('invalidateNewsCache', () => {
    it('should invalidate all news cache', async () => {
      await service.invalidateNewsCache();

      expect(cacheService.deleteByPattern).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidateNewsCategoryCache', () => {
    it('should invalidate specific category cache', async () => {
      const category = 'blockchain';

      await service.invalidateNewsCategoryCache(category);

      expect(cacheService.delete).toHaveBeenCalledWith(
        expect.stringContaining(category),
      );
    });
  });
});
