import { Test, TestingModule } from '@nestjs/testing';
import { QueueAdminController } from './queue-admin.controller';
import { QueueService } from '../services/queue.service';
import { BadRequestException } from '@nestjs/common';
import { JobStatus } from '../types/job.types';

describe('QueueAdminController', () => {
  let controller: QueueAdminController;

  const mockQueueService = {
    getQueueStats: jest.fn(),
    getQueueJobs: jest.fn(),
    getJobInfo: jest.fn(),
    getDeadLetterQueue: jest.fn(),
    requeueJob: jest.fn(),
    requeueFromDLQ: jest.fn(),
    purgeQueue: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [QueueAdminController],
      providers: [
        {
          provide: QueueService,
          useValue: mockQueueService,
        },
      ],
    }).compile();

    controller = module.get<QueueAdminController>(QueueAdminController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getAllQueueStats', () => {
    it('should return statistics for all queues', async () => {
      const mockStats = {
        active: 5,
        completed: 100,
        failed: 10,
        delayed: 2,
        waiting: 15,
      };

      mockQueueService.getQueueStats.mockResolvedValue(mockStats);

      const result = await controller.getAllQueueStats();

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(3);
      expect(mockQueueService.getQueueStats).toHaveBeenCalledTimes(3);
    });

    it('should include all queue names', async () => {
      mockQueueService.getQueueStats.mockResolvedValue({
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        waiting: 0,
      });

      const result = await controller.getAllQueueStats();

      const queueNames = result.data.map((item) => item.queue);
      expect(queueNames).toContain('deploy-contract');
      expect(queueNames).toContain('process-tts');
      expect(queueNames).toContain('index-market-news');
    });
  });

  describe('getQueueStats', () => {
    it('should return stats for valid queue name', async () => {
      const mockStats = {
        active: 5,
        completed: 100,
        failed: 10,
        delayed: 2,
        waiting: 15,
      };

      mockQueueService.getQueueStats.mockResolvedValue(mockStats);

      const result = await controller.getQueueStats('deploy-contract');

      expect(result.success).toBe(true);
      expect(result.queue).toBe('deploy-contract');
      expect(result.data).toEqual(mockStats);
    });

    it('should throw error for invalid queue name', async () => {
      await expect(controller.getQueueStats('invalid-queue')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should validate all queue names', async () => {
      mockQueueService.getQueueStats.mockResolvedValue({});

      // Valid queues should work
      await expect(
        controller.getQueueStats('deploy-contract'),
      ).resolves.toBeDefined();
      await expect(
        controller.getQueueStats('process-tts'),
      ).resolves.toBeDefined();
      await expect(
        controller.getQueueStats('index-market-news'),
      ).resolves.toBeDefined();
    });
  });

  describe('getQueueJobs', () => {
    it('should return jobs from queue', async () => {
      const mockJobs = [
        {
          id: '1',
          name: 'deploy-contract',
          status: JobStatus.COMPLETED,
          progress: 100,
        },
        {
          id: '2',
          name: 'deploy-contract',
          status: JobStatus.FAILED,
          progress: 0,
        },
      ];

      mockQueueService.getQueueJobs.mockResolvedValue(mockJobs);

      const result = await controller.getQueueJobs('deploy-contract');

      expect(result.success).toBe(true);
      expect(result.queue).toBe('deploy-contract');
      expect(result.count).toBe(2);
      expect(result.data).toEqual(mockJobs);
    });

    it('should filter jobs by status when provided', async () => {
      mockQueueService.getQueueJobs.mockResolvedValue([]);

      await controller.getQueueJobs('deploy-contract', 'failed,active');

      expect(mockQueueService.getQueueJobs).toHaveBeenCalledWith(
        'deploy-contract',
        ['failed', 'active'],
      );
    });

    it('should throw error for invalid queue name', async () => {
      await expect(controller.getQueueJobs('invalid-queue')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('getJob', () => {
    it('should return specific job details', async () => {
      const mockJob = {
        id: '123',
        name: 'deploy-contract',
        status: JobStatus.COMPLETED,
        progress: 100,
        data: { contractName: 'Test' },
      };

      mockQueueService.getJobInfo.mockResolvedValue(mockJob);

      const result = await controller.getJob('deploy-contract', '123');

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockJob);
    });

    it('should throw error if job not found', async () => {
      mockQueueService.getJobInfo.mockResolvedValue(null);

      await expect(controller.getJob('deploy-contract', '999')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw error for invalid queue name', async () => {
      await expect(controller.getJob('invalid-queue', '123')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('getDeadLetterQueue', () => {
    it('should return DLQ items', async () => {
      const mockDLQ = [
        { id: '1', name: 'deploy-contract', error: 'Timeout' },
        { id: '2', name: 'deploy-contract', error: 'Network error' },
      ];

      mockQueueService.getDeadLetterQueue.mockResolvedValue(mockDLQ);

      const result = await controller.getDeadLetterQueue('deploy-contract');

      expect(result.success).toBe(true);
      expect(result.queue).toBe('deploy-contract');
      expect(result.count).toBe(2);
      expect(result.data).toEqual(mockDLQ);
    });

    it('should respect limit parameter', async () => {
      mockQueueService.getDeadLetterQueue.mockResolvedValue([]);

      await controller.getDeadLetterQueue('deploy-contract', 100);

      expect(mockQueueService.getDeadLetterQueue).toHaveBeenCalledWith(
        'deploy-contract',
        100,
      );
    });

    it('should use default limit when not provided', async () => {
      mockQueueService.getDeadLetterQueue.mockResolvedValue([]);

      await controller.getDeadLetterQueue('deploy-contract');

      expect(mockQueueService.getDeadLetterQueue).toHaveBeenCalledWith(
        'deploy-contract',
        50,
      );
    });

    it('should throw error for invalid queue name', async () => {
      await expect(
        controller.getDeadLetterQueue('invalid-queue'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('requeueJob', () => {
    it('should requeue a job successfully', async () => {
      const mockRequeuedJob = { id: '456', name: 'deploy-contract' };
      mockQueueService.requeueJob.mockResolvedValue(mockRequeuedJob);

      const result = await controller.requeueJob('deploy-contract', '123');

      expect(result.success).toBe(true);
      expect(result.data.originalJobId).toBe('123');
      expect(result.data.newJobId).toBe('456');
      expect(result.data.queue).toBe('deploy-contract');
    });

    it('should throw error for invalid queue name', async () => {
      await expect(
        controller.requeueJob('invalid-queue', '123'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should propagate service errors', async () => {
      mockQueueService.requeueJob.mockRejectedValue(new Error('Job not found'));

      await expect(
        controller.requeueJob('deploy-contract', '999'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('requeueFromDLQ', () => {
    it('should requeue items from DLQ', async () => {
      const mockRequeuedJobs = [{ id: '1' }, { id: '2' }];

      mockQueueService.requeueFromDLQ.mockResolvedValue(mockRequeuedJobs);

      const result = await controller.requeueFromDLQ('deploy-contract');

      expect(result.success).toBe(true);
      expect(result.data.requeuedCount).toBe(2);
      expect(result.data.jobIds).toContain('1');
      expect(result.data.jobIds).toContain('2');
    });

    it('should respect limit parameter', async () => {
      mockQueueService.requeueFromDLQ.mockResolvedValue([]);

      await controller.requeueFromDLQ('deploy-contract', 20);

      expect(mockQueueService.requeueFromDLQ).toHaveBeenCalledWith(
        'deploy-contract',
        20,
      );
    });

    it('should use default limit when not provided', async () => {
      mockQueueService.requeueFromDLQ.mockResolvedValue([]);

      await controller.requeueFromDLQ('deploy-contract');

      expect(mockQueueService.requeueFromDLQ).toHaveBeenCalledWith(
        'deploy-contract',
        10,
      );
    });

    it('should throw error for invalid queue name', async () => {
      await expect(controller.requeueFromDLQ('invalid-queue')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('purgeQueue', () => {
    it('should purge queue successfully', async () => {
      mockQueueService.purgeQueue.mockResolvedValue(5);

      const result = await controller.purgeQueue('deploy-contract');

      expect(result.success).toBe(true);
      expect(result.data.purgeCounts).toBe(5);
    });

    it('should throw error for invalid queue name', async () => {
      await expect(controller.purgeQueue('invalid-queue')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
