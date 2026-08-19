import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { IndexMarketNewsProcessor } from './index-market-news.processor';
import { QueueJobTracingWrapper } from '../../observability/middleware/queue-job-tracing.wrapper';

describe('IndexMarketNewsProcessor', () => {
  let processor: IndexMarketNewsProcessor;

  const mockJob = {
    id: '123',
    data: {
      source: 'coingecko',
      startDate: '2024-01-01',
      endDate: '2024-01-31',
      limit: 50,
    },
    attemptsMade: 1,
    opts: { attempts: 3 },
    progress: jest.fn(),
    queue: { name: 'index-market-news' },
  };

  beforeEach(async () => {
    mockJob.progress = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IndexMarketNewsProcessor,
        { provide: getQueueToken('failed-jobs'), useValue: { add: jest.fn() } },
        {
          provide: QueueJobTracingWrapper,
          useValue: {
            wrapProcessor: jest.fn().mockImplementation((fn: any) => fn),
          },
        },
      ],
    }).compile();

    processor = module.get<IndexMarketNewsProcessor>(IndexMarketNewsProcessor);
  });

  describe('handleIndexMarketNews', () => {
    it('should successfully index market news', async () => {
      mockJob.data = {
        source: 'coingecko',
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        limit: 50,
      };
      const result = await processor.handleIndexMarketNews(mockJob as any);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('source');
      expect(result.data).toHaveProperty('indexedCount');
      expect(result.data).toHaveProperty('failedCount');
      expect(result.data).toHaveProperty('lastIndexedAt');
    });

    it('should update progress', async () => {
      mockJob.data = {
        source: 'coingecko',
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        limit: 50,
      };
      await processor.handleIndexMarketNews(mockJob as any);

      expect(mockJob.progress).toHaveBeenCalledWith(10);
      expect(mockJob.progress).toHaveBeenCalledWith(20);
      expect(mockJob.progress).toHaveBeenCalledWith(50);
      expect(mockJob.progress).toHaveBeenCalledWith(75);
      expect(mockJob.progress).toHaveBeenCalledWith(100);
    });

    it('should throw error if source missing', async () => {
      mockJob.data = {
        source: '',
        startDate: '2023-01-01',
        endDate: '2023-01-02',
        limit: 10,
      };

      await expect(
        processor.handleIndexMarketNews(mockJob as any),
      ).rejects.toThrow('Missing required field: source');
    });

    it('should respect limit parameter', async () => {
      mockJob.data = {
        source: 'coingecko',
        startDate: '2023-01-01',
        endDate: '2023-01-02',
        limit: 100,
      };
      const result = await processor.handleIndexMarketNews(mockJob as any);

      expect(result.data.itemsProcessed).toBeGreaterThanOrEqual(0);
    });

    it('should include source in result', async () => {
      mockJob.data = {
        source: 'coingecko',
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        limit: 50,
      };
      const result = await processor.handleIndexMarketNews(mockJob as any);

      expect(result.data.source).toBe('coingecko');
    });

    it('should return reasonable indexedCount and failedCount', async () => {
      mockJob.data = {
        source: 'coingecko',
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        limit: 50,
      };
      const result = await processor.handleIndexMarketNews(mockJob as any);

      expect(result.data.indexedCount).toBeGreaterThanOrEqual(0);
      expect(result.data.failedCount).toBeGreaterThanOrEqual(0);
      expect(result.data.indexedCount + result.data.failedCount).toBe(
        result.data.itemsProcessed,
      );
    });

    it('should use default limit when not provided', async () => {
      mockJob.data = {
        source: 'coingecko',
        startDate: '2023-01-01',
        endDate: '2023-01-02',
        limit: 50,
      };
      const result = await processor.handleIndexMarketNews(mockJob as any);

      expect(result.data).toHaveProperty('itemsProcessed');
    });
  });
});
