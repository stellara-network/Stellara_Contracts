import { Test, TestingModule } from '@nestjs/testing';
import { NewsApiService } from './news-api.service';
import { NewsCacheService } from './news-cache.service';

describe('NewsApiService', () => {
  let service: NewsApiService;
  let newsCacheService: NewsCacheService;

  beforeEach(async () => {
    const mockNewsCacheService = {
      getNews: jest.fn(),
      getTrendingNews: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NewsApiService,
        {
          provide: NewsCacheService,
          useValue: mockNewsCacheService,
        },
      ],
    }).compile();

    service = module.get<NewsApiService>(NewsApiService);
    newsCacheService = module.get<NewsCacheService>(NewsCacheService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getNews', () => {
    it('should return news articles', async () => {
      const category = 'blockchain';
      const mockNews = [
        {
          id: '1',
          title: 'Blockchain News 1',
          description: 'News description',
          source: 'CryptoNews',
          category,
          url: 'https://example.com/news/1',
          publishedAt: new Date(),
          sentiment: 'positive' as const,
        },
      ];

      (newsCacheService.getNews as jest.Mock).mockResolvedValue(mockNews);

      const result = await service.getNews(category);

      expect(result).toEqual(mockNews);
      expect(newsCacheService.getNews).toHaveBeenCalledWith(
        category,
        expect.any(Function),
      );
    });

    it('should return news with default category', async () => {
      const mockNews = [
        {
          id: '1',
          title: 'News 1',
          description: 'News description',
          source: 'CryptoNews',
          category: 'all',
          url: 'https://example.com/news/1',
          publishedAt: new Date(),
        },
      ];

      (newsCacheService.getNews as jest.Mock).mockResolvedValue(mockNews);

      const result = await service.getNews();

      expect(result).toEqual(mockNews);
      expect(newsCacheService.getNews).toHaveBeenCalledWith(
        'all',
        expect.any(Function),
      );
    });
  });

  describe('getTrendingNews', () => {
    it('should return trending news articles', async () => {
      const mockTrendingNews = [
        {
          id: 'trending-1',
          title: 'Bitcoin Reaches New All-Time High',
          description: 'Crypto markets surge',
          source: 'CryptoNews',
          category: 'market-updates',
          url: 'https://example.com/news/trending/1',
          publishedAt: new Date(),
          sentiment: 'positive' as const,
        },
      ];

      (newsCacheService.getTrendingNews as jest.Mock).mockResolvedValue(
        mockTrendingNews,
      );

      const result = await service.getTrendingNews();

      expect(result).toEqual(mockTrendingNews);
      expect(newsCacheService.getTrendingNews).toHaveBeenCalledWith(
        expect.any(Function),
      );
    });

    it('should call provider function when getTrendingNews called', async () => {
      (newsCacheService.getTrendingNews as jest.Mock).mockImplementation(
        async (provider) => provider(),
      );

      const result = await service.getTrendingNews();

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
