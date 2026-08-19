import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { QueueService } from './queue.service';
import { RedisService } from '../../redis/redis.service';
import { QueueJobTracingWrapper } from '../../observability/middleware/queue-job-tracing.wrapper';
import { QueueIdempotencyGuard } from '../queue-idempotency.guard';
import { JobStatus } from '../types/job.types';

describe('QueueService', () => {
  let service: QueueService;
  let mockRedisService: any;
  let mockQueues: any;

  const mockJob = {
    id: '123',
    name: 'test-job',
    data: { test: 'data' },
    returnvalue: { success: true },
    failedReason: null,
    timestamp: Date.now(),
    processedOn: null,
    finishedOn: null,
    attemptsMade: 1,
    opts: { attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
    progress: jest.fn(),
    getState: jest.fn(),
  };

  const mockQueue = {
    name: 'test-queue',
    add: jest.fn(),
    getJob: jest.fn(),
    getJobs: jest.fn(),
    clean: jest.fn(),
    getJobCounts: jest.fn(),
    on: jest.fn(),
  };

  beforeEach(async () => {
    mockRedisService = {
      client: {
        lRange: jest.fn(),
        rPush: jest.fn(),
        lTrim: jest.fn(),
        set: jest.fn().mockResolvedValue('OK'),
        get: jest.fn().mockResolvedValue(null),
        del: jest.fn().mockResolvedValue(1),
      },
    };

    mockQueues = {
      deployContractQueue: mockQueue,
      processTtsQueue: mockQueue,
      indexMarketNewsQueue: mockQueue,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QueueService,
        QueueIdempotencyGuard,
        {
          provide: QueueJobTracingWrapper,
          useValue: {
            injectTraceContext: jest
              .fn()
              .mockImplementation((_data: any) => _data),
            wrapProcessor: jest.fn().mockImplementation((fn: any) => fn),
          },
        },
        {
          provide: getQueueToken('deploy-contract'),
          useValue: mockQueue,
        },
        {
          provide: getQueueToken('process-tts'),
          useValue: mockQueue,
        },
        {
          provide: getQueueToken('index-market-news'),
          useValue: mockQueue,
        },
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
      ],
    }).compile();

    service = module.get<QueueService>(QueueService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('addJob', () => {
    it('should add a job to the queue', async () => {
      const jobData = { test: 'data' };
      mockQueue.add.mockResolvedValue(mockJob);

      const result = await service.addJob(
        'deploy-contract',
        'test-job',
        jobData,
      );

      expect(mockQueue.add).toHaveBeenCalledWith(
        'test-job',
        jobData,
        expect.any(Object),
      );
      expect(result).toEqual(mockJob);
    });

    it('should throw error for unknown queue', async () => {
      await expect(service.addJob('unknown-queue', 'job', {})).rejects.toThrow(
        'Unknown queue: unknown-queue',
      );
    });

    it('should pass options to queue.add', async () => {
      const jobData = { test: 'data' };
      const options = { attempts: 5 };
      mockQueue.add.mockResolvedValue(mockJob);

      await service.addJob('deploy-contract', 'test-job', jobData, options);

      expect(mockQueue.add).toHaveBeenCalledWith(
        'test-job',
        jobData,
        expect.objectContaining(options),
      );
    });
  });

  describe('getJobInfo', () => {
    it('should return job info for existing job', async () => {
      mockQueue.getJob.mockResolvedValue(mockJob);
      mockJob.getState.mockResolvedValue('completed');
      mockJob.progress.mockReturnValue(100);

      const result = await service.getJobInfo('deploy-contract', '123');

      expect(result).toEqual(
        expect.objectContaining({
          id: '123',
          name: 'test-job',
          status: JobStatus.COMPLETED,
          progress: 100,
        }),
      );
    });

    it('should return null for non-existing job', async () => {
      mockQueue.getJob.mockResolvedValue(null);

      const result = await service.getJobInfo(
        'deploy-contract',
        'non-existent',
      );

      expect(result).toBeNull();
    });

    it('should map job states correctly', async () => {
      const states = [
        'pending' as const,
        'active' as const,
        'completed' as const,
        'failed' as const,
        'delayed' as const,
      ];
      const expectedStatuses = [
        JobStatus.PENDING,
        JobStatus.ACTIVE,
        JobStatus.COMPLETED,
        JobStatus.FAILED,
        JobStatus.DELAYED,
      ];

      for (let i = 0; i < states.length; i++) {
        mockQueue.getJob.mockResolvedValue(mockJob);
        mockJob.getState.mockResolvedValue(states[i]);
        mockJob.progress.mockReturnValue(0);

        const result = await service.getJobInfo('deploy-contract', '123');

        expect(result?.status).toBe(expectedStatuses[i]);
      }
    });
  });

  describe('requeueJob', () => {
    it('should requeue a failed job', async () => {
      const newJob = { ...mockJob, id: '456' };
      mockQueue.getJob.mockResolvedValue(mockJob);
      mockQueue.add.mockResolvedValue(newJob);

      const result = await service.requeueJob('deploy-contract', '123');

      expect(mockQueue.getJob).toHaveBeenCalledWith('123');
      expect(mockQueue.add).toHaveBeenCalled();
      expect(result).toEqual(newJob);
    });

    it('should throw error for non-existing job', async () => {
      mockQueue.getJob.mockResolvedValue(null);

      await expect(
        service.requeueJob('deploy-contract', 'non-existent'),
      ).rejects.toThrow('Job non-existent not found');
    });

    it('should preserve job data and options when requeuing', async () => {
      mockQueue.getJob.mockResolvedValue(mockJob);
      mockQueue.add.mockResolvedValue(mockJob);

      await service.requeueJob('deploy-contract', '123');

      expect(mockQueue.add).toHaveBeenCalledWith(
        mockJob.name,
        mockJob.data,
        expect.objectContaining({
          removeOnComplete: false,
          removeOnFail: false,
        }),
      );
    });
  });

  describe('getQueueStats', () => {
    it('should return queue statistics', async () => {
      const mockCounts = {
        active: 5,
        completed: 100,
        failed: 10,
        delayed: 2,
        waiting: 15,
      };
      mockQueue.getJobCounts.mockResolvedValue(mockCounts);

      const result = await service.getQueueStats('deploy-contract');

      expect(result).toEqual(mockCounts);
    });

    it('should handle missing counts', async () => {
      mockQueue.getJobCounts.mockResolvedValue({});

      const result = await service.getQueueStats('deploy-contract');

      expect(result).toEqual({
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        waiting: 0,
      });
    });
  });

  describe('getDeadLetterQueue', () => {
    it('should retrieve DLQ items', async () => {
      const dlqItems = [
        JSON.stringify({ id: '1', name: 'failed-job' }),
        JSON.stringify({ id: '2', name: 'failed-job' }),
      ];
      mockRedisService.client.lRange.mockResolvedValue(dlqItems);

      const result = await service.getDeadLetterQueue('deploy-contract');

      expect(result).toEqual([
        { id: '1', name: 'failed-job' },
        { id: '2', name: 'failed-job' },
      ]);
    });

    it('should respect limit parameter', async () => {
      mockRedisService.client.lRange.mockResolvedValue([]);

      await service.getDeadLetterQueue('deploy-contract', 10);

      expect(mockRedisService.client.lRange).toHaveBeenCalledWith(
        'queue:dlq:deploy-contract',
        0,
        9,
      );
    });

    it('should handle invalid JSON in DLQ', async () => {
      const dlqItems = [
        JSON.stringify({ id: '1', name: 'failed-job' }),
        'invalid json',
      ];
      mockRedisService.client.lRange.mockResolvedValue(dlqItems);

      const result = await service.getDeadLetterQueue('deploy-contract');

      expect(result[0]).toEqual({ id: '1', name: 'failed-job' });
      expect(result[1]).toBe('invalid json');
    });
  });

  describe('purgeQueue', () => {
    it('should purge failed jobs from queue', async () => {
      mockQueue.clean.mockResolvedValue(new Array(10).fill({ id: 'x' }));

      const result = await service.purgeQueue('deploy-contract');

      expect(mockQueue.clean).toHaveBeenCalledWith(0, 'failed');
      expect(result).toBe(10);
    });
  });

  describe('updateJobProgress', () => {
    it('should update job progress', async () => {
      mockQueue.getJob.mockResolvedValue(mockJob);

      await service.updateJobProgress('deploy-contract', '123', 50);

      expect(mockJob.progress).toHaveBeenCalledWith(50);
    });

    it('should throw error if job not found', async () => {
      mockQueue.getJob.mockResolvedValue(null);

      await expect(
        service.updateJobProgress('deploy-contract', 'non-existent', 50),
      ).rejects.toThrow('Job non-existent not found');
    });
  });

  describe('requeueFromDLQ', () => {
    it('should requeue items from dead-letter queue', async () => {
      const dlqItems = [
        JSON.stringify({
          id: '1',
          name: 'failed-job',
          data: { test: 'data' },
          maxAttempts: 3,
        }),
      ];
      mockRedisService.client.lRange.mockResolvedValue(dlqItems);
      mockQueue.add.mockResolvedValue(mockJob);

      const result = await service.requeueFromDLQ('deploy-contract', 10);

      expect(mockQueue.add).toHaveBeenCalled();
      expect(result.length).toBe(1);
    });

    it('should trim DLQ after requeuing', async () => {
      const dlqItems = [
        JSON.stringify({
          id: '1',
          name: 'failed-job',
          data: { test: 'data' },
        }),
      ];
      mockRedisService.client.lRange.mockResolvedValue(dlqItems);
      mockQueue.add.mockResolvedValue(mockJob);

      await service.requeueFromDLQ('deploy-contract', 10);

      expect(mockRedisService.client.lTrim).toHaveBeenCalledWith(
        'queue:dlq:deploy-contract',
        1,
        -1,
      );
    });

    it('should handle errors when requeuing individual items', async () => {
      const dlqItems = [JSON.stringify({ invalid: 'data' }), 'not json'];
      mockRedisService.client.lRange.mockResolvedValue(dlqItems);

      const result = await service.requeueFromDLQ('deploy-contract', 10);

      // Should continue despite errors
      expect(result).toBeDefined();
    });
  });
});
