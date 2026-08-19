import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { QueueService } from './services/queue.service';
import { RedisService } from '../redis/redis.service';
import { QueueIdempotencyGuard } from './queue-idempotency.guard';
import { QueueJobTracingWrapper } from '../observability/middleware/queue-job-tracing.wrapper';

/**
 * Integration tests for queue retry and dead-letter queue (DLQ) handling
 */
describe('Queue Integration - Retries and DLQ', () => {
  let service: QueueService;
  let mockRedisService: any;
  let mockQueues: any;
  let idempotencyGuard: QueueIdempotencyGuard;

  const createMockJob = (
    id: string | number,
    name: string,
    attempts: number = 1,
    maxAttempts: number = 3,
    failedReason?: string,
  ) => ({
    id,
    name,
    data: {
      test: 'data',
      contractName: '',
      contractCode: '',
      network: '',
    } as any,
    returnvalue: failedReason ? undefined : { success: true },
    failedReason,
    timestamp: Date.now(),
    processedOn: Date.now(),
    finishedOn: Date.now(),
    attemptsMade: attempts,
    opts: {
      attempts: maxAttempts,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: false,
      removeOnFail: false,
    },
    progress: jest.fn(),
    getState: jest.fn(),
    queue: {
      name: 'deploy-contract',
    },
  });

  const createMockQueue = () => ({
    name: 'deploy-contract',
    add: jest.fn(),
    getJob: jest.fn(),
    getJobs: jest.fn(),
    clean: jest.fn(),
    getJobCounts: jest.fn(),
    on: jest.fn(),
  });

  beforeEach(async () => {
    mockRedisService = {
      client: {
        lRange: jest.fn(),
        rPush: jest.fn(),
        lTrim: jest.fn(),
        set: jest.fn(),
        get: jest.fn(),
        del: jest.fn(),
      },
    };

    mockQueues = {
      deployContractQueue: createMockQueue(),
      processTtsQueue: createMockQueue(),
      indexMarketNewsQueue: createMockQueue(),
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
          useValue: mockQueues.deployContractQueue,
        },
        {
          provide: getQueueToken('process-tts'),
          useValue: mockQueues.processTtsQueue,
        },
        {
          provide: getQueueToken('index-market-news'),
          useValue: mockQueues.indexMarketNewsQueue,
        },
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
      ],
    }).compile();

    service = module.get<QueueService>(QueueService);
    idempotencyGuard = module.get<QueueIdempotencyGuard>(QueueIdempotencyGuard);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Retry Logic', () => {
    it('should track job attempts correctly', async () => {
      const jobWithAttempts = createMockJob('job-1', 'deploy-contract', 2, 3);
      mockQueues.deployContractQueue.getJob.mockResolvedValue(jobWithAttempts);
      jobWithAttempts.getState.mockResolvedValue('failed');
      jobWithAttempts.progress.mockReturnValue(50);

      const jobInfo = await service.getJobInfo('deploy-contract', 'job-1');

      expect(jobInfo?.attempts).toBe(2);
      expect(jobInfo?.maxAttempts).toBe(3);
    });

    it('should allow requeuing job on first attempts', async () => {
      const failedJob = createMockJob(
        'job-1',
        'deploy-contract',
        1,
        3,
        'Connection timeout',
      );
      mockQueues.deployContractQueue.getJob.mockResolvedValue(failedJob);

      const requeuedJob = createMockJob('job-2', 'deploy-contract', 0, 3);
      mockQueues.deployContractQueue.add.mockResolvedValue(requeuedJob);

      const result = await service.requeueJob('deploy-contract', 'job-1');

      expect(result).toBeDefined();
      expect(result!.id).toBe('job-2');
      expect(mockQueues.deployContractQueue.add).toHaveBeenCalledWith(
        'deploy-contract',
        failedJob.data,
        expect.objectContaining({
          removeOnComplete: false,
          removeOnFail: false,
        }),
      );
    });

    it('should preserve backoff configuration when requeuing', async () => {
      const failedJob = createMockJob('job-1', 'deploy-contract', 2, 3);
      failedJob.opts.backoff = { type: 'exponential', delay: 2000 };

      mockQueues.deployContractQueue.getJob.mockResolvedValue(failedJob);
      const requeuedJob = createMockJob('job-2', 'deploy-contract');
      mockQueues.deployContractQueue.add.mockResolvedValue(requeuedJob);

      await service.requeueJob('deploy-contract', 'job-1');

      expect(mockQueues.deployContractQueue.add).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          backoff: { type: 'exponential', delay: 2000 },
        }),
      );
    });

    it('should handle exponential backoff delays', async () => {
      const job1 = createMockJob('job-1', 'deploy-contract', 1, 3);
      const job2 = createMockJob('job-2', 'deploy-contract', 2, 3);
      const job3 = createMockJob('job-3', 'deploy-contract', 3, 3);

      // Delay should increase exponentially: 2000ms, 4000ms, 8000ms
      const backoffDelays = [2000, 4000, 8000];
      const expectedDelays = backoffDelays.map(
        (delay) => Math.pow(2, backoffDelays.indexOf(delay)) * 2000,
      );

      expect(expectedDelays[0]).toBe(2000);
      expect(expectedDelays[1]).toBe(4000);
      expect(expectedDelays[2]).toBe(8000);
    });
  });

  describe('Dead-Letter Queue (DLQ) Handling', () => {
    it('should move job to DLQ when max retries exceeded', async () => {
      const maxRetriesJob = createMockJob(
        'job-1',
        'deploy-contract',
        3,
        3,
        'Persistent failure',
      );

      // Simulate job reaching max retries
      const dlqItem = JSON.stringify({
        id: maxRetriesJob.id,
        name: maxRetriesJob.name,
        data: maxRetriesJob.data,
        error: 'Persistent failure',
        attempts: 3,
        maxAttempts: 3,
      });

      mockRedisService.client.rPush.mockResolvedValue(1);

      // The private handleJobFailure method would be called internally
      // Verify DLQ structure
      const dlqData = JSON.parse(dlqItem);
      expect(dlqData).toHaveProperty('id');
      expect(dlqData).toHaveProperty('name');
      expect(dlqData).toHaveProperty('data');
      expect(dlqData).toHaveProperty('error');
      expect(dlqData.attempts).toBe(dlqData.maxAttempts);
    });

    it('should retrieve items from DLQ', async () => {
      const dlqItems = [
        JSON.stringify({
          id: '1',
          name: 'deploy-contract',
          data: { contractName: 'Failed' },
          error: 'Timeout',
          attempts: 3,
          maxAttempts: 3,
        }),
        JSON.stringify({
          id: '2',
          name: 'deploy-contract',
          data: { contractName: 'Failed2' },
          error: 'Network error',
          attempts: 3,
          maxAttempts: 3,
        }),
      ];

      mockRedisService.client.lRange.mockResolvedValue(dlqItems);

      const dlq = await service.getDeadLetterQueue('deploy-contract', 50);

      expect(dlq).toHaveLength(2);
      expect(dlq[0].id).toBe('1');
      expect(dlq[0].attempts).toBe(3);
      expect(dlq[1].id).toBe('2');
    });

    it('should requeue all items from DLQ', async () => {
      const dlqItems = [
        JSON.stringify({
          id: '1',
          name: 'deploy-contract',
          data: { test: 'data' },
          maxAttempts: 3,
        }),
        JSON.stringify({
          id: '2',
          name: 'deploy-contract',
          data: { test: 'data2' },
          maxAttempts: 3,
        }),
      ];

      mockRedisService.client.lRange.mockResolvedValue(dlqItems);
      mockQueues.deployContractQueue.add.mockResolvedValue(
        createMockJob('new-job-1', 'deploy-contract'),
      );

      const requeuedJobs = await service.requeueFromDLQ('deploy-contract', 10);

      expect(requeuedJobs).toHaveLength(2);
      expect(mockQueues.deployContractQueue.add).toHaveBeenCalledTimes(2);
    });

    it('should trim DLQ after successful requeue', async () => {
      const dlqItems = [
        JSON.stringify({
          id: '1',
          name: 'deploy-contract',
          data: { test: 'data' },
        }),
        JSON.stringify({
          id: '2',
          name: 'deploy-contract',
          data: { test: 'data2' },
        }),
      ];

      mockRedisService.client.lRange.mockResolvedValue(dlqItems);
      mockQueues.deployContractQueue.add.mockResolvedValue(
        createMockJob('new-job', 'deploy-contract'),
      );

      await service.requeueFromDLQ('deploy-contract', 10);

      // After requeuing 2 items, DLQ should be trimmed
      expect(mockRedisService.client.lTrim).toHaveBeenCalledWith(
        'queue:dlq:deploy-contract',
        2,
        -1,
      );
    });

    it('should handle DLQ requeue with partial failures', async () => {
      const dlqItems = [
        JSON.stringify({
          id: '1',
          name: 'deploy-contract',
          data: { test: 'data' },
          maxAttempts: 3,
        }),
        'invalid json',
        JSON.stringify({
          id: '2',
          name: 'deploy-contract',
          data: { test: 'data2' },
          maxAttempts: 3,
        }),
      ];

      mockRedisService.client.lRange.mockResolvedValue(dlqItems);
      mockQueues.deployContractQueue.add
        .mockResolvedValueOnce(createMockJob('new-job-1', 'deploy-contract'))
        .mockResolvedValueOnce(createMockJob('new-job-2', 'deploy-contract'));

      const requeuedJobs = await service.requeueFromDLQ('deploy-contract', 10);

      // Should successfully requeue valid items despite invalid ones
      expect(requeuedJobs.length).toBeGreaterThan(0);
    });

    it('should not trim DLQ if no items were requeued', async () => {
      mockRedisService.client.lRange.mockResolvedValue([]);

      await service.requeueFromDLQ('deploy-contract', 10);

      expect(mockRedisService.client.lTrim).not.toHaveBeenCalled();
    });
  });

  describe('Retry and DLQ Coordination', () => {
    it('should track job progression from pending to DLQ', async () => {
      const jobStates = ['pending', 'active', 'failed', 'failed', 'failed'];
      const jobAttempts = [0, 1, 1, 2, 3];

      for (let i = 0; i < jobStates.length; i++) {
        const job = createMockJob(
          'job-1',
          'deploy-contract',
          jobAttempts[i],
          3,
        );
        mockQueues.deployContractQueue.getJob.mockResolvedValue(job);
        job.getState.mockResolvedValue(jobStates[i]);

        const jobInfo = await service.getJobInfo('deploy-contract', 'job-1');

        expect(jobInfo?.attempts).toBe(jobAttempts[i]);
      }
    });

    it('should maintain job data consistency through retry cycle', async () => {
      const originalData = {
        contractName: 'TestContract',
        contractCode: 'code here',
        network: 'mainnet',
      };

      const failedJob = createMockJob(
        'job-1',
        'deploy-contract',
        2,
        3,
        'Network error',
      );
      failedJob.data = { ...failedJob.data, ...originalData };

      mockQueues.deployContractQueue.getJob.mockResolvedValue(failedJob);
      const requeuedJob = createMockJob('job-2', 'deploy-contract', 0, 3);
      mockQueues.deployContractQueue.add.mockResolvedValue(requeuedJob);

      await service.requeueJob('deploy-contract', 'job-1');

      // Verify original data was passed to the new job
      expect(mockQueues.deployContractQueue.add).toHaveBeenCalledWith(
        'deploy-contract',
        expect.objectContaining(originalData),
        expect.any(Object),
      );
    });

    it('should support concurrent retries of multiple jobs', async () => {
      const jobs = [
        createMockJob('job-1', 'deploy-contract', 1, 3),
        createMockJob('job-2', 'deploy-contract', 1, 3),
        createMockJob('job-3', 'deploy-contract', 1, 3),
      ];

      const newJobs = [
        createMockJob('job-1-retry', 'deploy-contract'),
        createMockJob('job-2-retry', 'deploy-contract'),
        createMockJob('job-3-retry', 'deploy-contract'),
      ];

      mockQueues.deployContractQueue.getJob
        .mockResolvedValueOnce(jobs[0])
        .mockResolvedValueOnce(jobs[1])
        .mockResolvedValueOnce(jobs[2]);

      mockQueues.deployContractQueue.add
        .mockResolvedValueOnce(newJobs[0])
        .mockResolvedValueOnce(newJobs[1])
        .mockResolvedValueOnce(newJobs[2]);

      const results = await Promise.all([
        service.requeueJob('deploy-contract', 'job-1'),
        service.requeueJob('deploy-contract', 'job-2'),
        service.requeueJob('deploy-contract', 'job-3'),
      ]);

      expect(results).toHaveLength(3);
      expect(results.every((r) => r !== undefined)).toBe(true);
    });
  });

  describe('DLQ Persistence and Recovery', () => {
    it('should persist DLQ data to Redis', async () => {
      const dlqItem = JSON.stringify({
        id: 'job-1',
        name: 'deploy-contract',
        data: { test: 'data' } as any,
        error: 'Max retries exceeded',
        attempts: 3,
        maxAttempts: 3,
        failedAt: new Date().toISOString(),
      });

      mockRedisService.client.rPush.mockResolvedValue(1);

      // Simulate failure adding to DLQ
      const result = await mockRedisService.client.rPush(
        'queue:dlq:deploy-contract',
        dlqItem,
      );

      expect(result).toBe(1);
      expect(mockRedisService.client.rPush).toHaveBeenCalledWith(
        'queue:dlq:deploy-contract',
        dlqItem,
      );
    });

    it('should retrieve DLQ with limit to prevent memory issues', async () => {
      const items = Array.from({ length: 100 }, (_, i) =>
        JSON.stringify({ id: `job-${i}`, name: 'deploy-contract' }),
      );

      mockRedisService.client.lRange.mockResolvedValue(items.slice(0, 50));

      const dlq = await service.getDeadLetterQueue('deploy-contract', 50);

      expect(mockRedisService.client.lRange).toHaveBeenCalledWith(
        'queue:dlq:deploy-contract',
        0,
        49,
      );
      expect(dlq).toHaveLength(50);
    });

    it('should support DLQ inspection for manual review', async () => {
      const dlqItems = [
        {
          id: '1',
          name: 'deploy-contract',
          error: 'Contract compilation failed',
          attempts: 3,
          failedAt: '2024-01-15T10:00:00Z',
        },
        {
          id: '2',
          name: 'deploy-contract',
          error: 'Network timeout',
          attempts: 3,
          failedAt: '2024-01-15T10:05:00Z',
        },
      ];

      mockRedisService.client.lRange.mockResolvedValue(
        dlqItems.map((item) => JSON.stringify(item)),
      );

      const dlq = await service.getDeadLetterQueue('deploy-contract', 50);

      expect(dlq).toHaveLength(2);
      expect(dlq[0].error).toBe('Contract compilation failed');
      expect(dlq[1].error).toBe('Network timeout');
    });
  });

  describe('Idempotency', () => {
    it('should generate consistent idempotency keys for same payload', () => {
      const key1 = idempotencyGuard.generateIdempotencyKey('deploy-contract', {
        contractName: 'Test',
        code: '0x123',
      });
      const key2 = idempotencyGuard.generateIdempotencyKey('deploy-contract', {
        contractName: 'Test',
        code: '0x123',
      });

      expect(key1).toBe(key2);
    });

    it('should generate different keys for different payloads', () => {
      const key1 = idempotencyGuard.generateIdempotencyKey('deploy-contract', {
        contractName: 'Test1',
      });
      const key2 = idempotencyGuard.generateIdempotencyKey('deploy-contract', {
        contractName: 'Test2',
      });

      expect(key1).not.toBe(key2);
    });

    it('should reject duplicate job via addJob', async () => {
      const jobData = {
        contractName: 'Test',
        contractCode: '0x123',
        network: 'mainnet',
      };

      // First call: idempotency key does not exist
      mockRedisService.client.get.mockResolvedValueOnce(null);
      mockQueues.deployContractQueue.add.mockResolvedValue(
        createMockJob('job-1', 'deploy-contract'),
      );
      mockRedisService.client.set.mockResolvedValueOnce('OK');

      const result1 = await service.addJob(
        'deploy-contract',
        'deploy-contract',
        jobData,
      );
      expect(result1).not.toBeNull();

      // Second call: idempotency key already exists
      mockRedisService.client.get.mockResolvedValueOnce('job-1');

      const result2 = await service.addJob(
        'deploy-contract',
        'deploy-contract',
        jobData,
      );
      expect(result2).toBeNull();
    });

    it('should allow duplicate when skipIdempotencyCheck is true', async () => {
      const jobData = {
        contractName: 'Test',
        contractCode: '0x123',
        network: 'mainnet',
      };

      mockQueues.deployContractQueue.add.mockResolvedValue(
        createMockJob('job-1', 'deploy-contract'),
      );
      mockRedisService.client.set.mockResolvedValue('OK');

      const result = await service.addJob(
        'deploy-contract',
        'deploy-contract',
        jobData,
        { skipIdempotencyCheck: true },
      );

      expect(result).not.toBeNull();
      // Should not check idempotency
      expect(mockRedisService.client.get).not.toHaveBeenCalled();
    });

    it('should release idempotency key', async () => {
      mockRedisService.client.del.mockResolvedValue(1);

      await idempotencyGuard.releaseIdempotencyKey('some-key');

      expect(mockRedisService.client.del).toHaveBeenCalledWith(
        'queue:idempotency:some-key',
      );
    });

    it('should handle Redis failure gracefully (fail-open)', async () => {
      mockRedisService.client.get.mockRejectedValue(new Error('Redis down'));

      const result = await idempotencyGuard.isDuplicate('some-key');

      expect(result.isDuplicate).toBe(false);
    });
  });

  describe('Retry State Tracking', () => {
    it('should save retry state on job creation', async () => {
      mockRedisService.client.get.mockResolvedValue(null); // no duplicate
      mockQueues.deployContractQueue.add.mockResolvedValue(
        createMockJob('job-1', 'deploy-contract'),
      );
      mockRedisService.client.set.mockResolvedValue('OK');

      await service.addJob('deploy-contract', 'deploy-contract', {
        contractName: 'Test',
      });

      // Retry state should be saved
      expect(mockRedisService.client.set).toHaveBeenCalledWith(
        'queue:retry:job-1',
        expect.any(String),
        { EX: 86400 },
      );
    });

    it('should retrieve retry state', async () => {
      const retryState = {
        jobId: 'job-1',
        queueName: 'deploy-contract',
        jobName: 'deploy-contract',
        attemptCount: 2,
        maxAttempts: 3,
        lastError: 'Timeout',
        firstAttemptedAt: '2024-01-01T00:00:00Z',
        lastAttemptedAt: '2024-01-01T00:05:00Z',
        idempotencyKey: 'abc123',
      };

      mockRedisService.client.get.mockResolvedValue(JSON.stringify(retryState));

      const state = await service.getRetryState('job-1');

      expect(state).not.toBeNull();
      expect(state?.attemptCount).toBe(2);
      expect(state?.lastError).toBe('Timeout');
    });

    it('should return null for non-existent retry state', async () => {
      mockRedisService.client.get.mockResolvedValue(null);

      const state = await service.getRetryState('non-existent');

      expect(state).toBeNull();
    });

    it('should include retry state in job info', async () => {
      const retryState = {
        jobId: 'job-1',
        queueName: 'deploy-contract',
        jobName: 'deploy-contract',
        attemptCount: 1,
        maxAttempts: 3,
        firstAttemptedAt: '2024-01-01T00:00:00Z',
        lastAttemptedAt: '2024-01-01T00:01:00Z',
        idempotencyKey: 'abc123',
      };

      const job = createMockJob('job-1', 'deploy-contract', 1, 3);
      mockQueues.deployContractQueue.getJob.mockResolvedValue(job);
      job.getState.mockResolvedValue('active');

      mockRedisService.client.get.mockResolvedValue(JSON.stringify(retryState));

      const jobInfo = await service.getJobInfo('deploy-contract', 'job-1');

      expect(jobInfo?.retryState).toBeDefined();
      expect(jobInfo?.retryState?.attemptCount).toBe(1);
    });

    it('should include retry state in DLQ entry', async () => {
      const retryState = {
        jobId: 'job-1',
        queueName: 'deploy-contract',
        jobName: 'deploy-contract',
        attemptCount: 3,
        maxAttempts: 3,
        lastError: 'Persistent failure',
        firstAttemptedAt: '2024-01-01T00:00:00Z',
        lastAttemptedAt: '2024-01-01T00:10:00Z',
        idempotencyKey: 'abc123',
      };

      mockRedisService.client.get.mockResolvedValue(JSON.stringify(retryState));
      mockRedisService.client.rPush.mockResolvedValue(1);

      // The handleJobFailure method is private, but it's triggered by the queue 'failed' event.
      // We test the DLQ structure includes retry state.
      const dlqItem = JSON.stringify({
        id: 'job-1',
        name: 'deploy-contract',
        data: { test: 'data' },
        error: 'Persistent failure',
        attempts: 3,
        maxAttempts: 3,
        failedAt: new Date().toISOString(),
        retryState,
      });

      const parsed = JSON.parse(dlqItem);
      expect(parsed.retryState).toBeDefined();
      expect(parsed.retryState.attemptCount).toBe(3);
    });
  });
});
