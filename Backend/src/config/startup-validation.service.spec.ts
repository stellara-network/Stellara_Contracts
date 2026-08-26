import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { StartupValidationService } from './startup-validation.service';
import { SecretsMaskingService } from './secrets-masking.service';

// Mock the redis module
jest.mock('redis', () => ({
  createClient: jest.fn(),
}));

import { createClient } from 'redis';

describe('StartupValidationService', () => {
  let service: StartupValidationService;
  let dataSource: DataSource;
  let configService: ConfigService;
  let maskingService: SecretsMaskingService;

  const mockRedisClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue('PONG'),
    quit: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    (createClient as jest.Mock).mockReturnValue(mockRedisClient);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StartupValidationService,
        {
          provide: DataSource,
          useValue: {
            query: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
        {
          provide: SecretsMaskingService,
          useValue: {
            mask: jest.fn((s: string) => s),
            maskError: jest.fn((e: Error) => e),
          },
        },
      ],
    }).compile();

    service = module.get<StartupValidationService>(StartupValidationService);
    dataSource = module.get<DataSource>(DataSource);
    configService = module.get<ConfigService>(ConfigService);
    maskingService = module.get<SecretsMaskingService>(SecretsMaskingService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('validate', () => {
    const defaultConfig: Record<string, string | undefined> = {
      DB_HOST: 'localhost',
      DB_PORT: '5432',
      DB_DATABASE: 'stellara_db',
      REDIS_URL: 'redis://localhost:6379',
      REDIS_HOST: undefined,
      REDIS_PORT: undefined,
      REDIS_QUEUE_DB: '1',
      QUEUE_DEPLOY_CONTRACT_CONCURRENCY: '2',
      QUEUE_PROCESS_TTS_CONCURRENCY: '4',
      QUEUE_INDEX_MARKET_NEWS_CONCURRENCY: '3',
    };

    beforeEach(() => {
      (configService.get as jest.Mock).mockImplementation(
        (key: string) => defaultConfig[key],
      );
      (dataSource.query as jest.Mock).mockResolvedValue([{ ok: 1 }]);
    });

    it('should return success when all dependencies are healthy', async () => {
      const report = await service.validate({ failOnError: false });

      expect(report.success).toBe(true);
      expect(report.checks).toHaveLength(3);
      expect(report.checks.every((c) => c.status === 'ok')).toBe(true);
    });

    it('should include database check details', async () => {
      const report = await service.validate({ failOnError: false });

      const dbCheck = report.checks.find((c) => c.name === 'database');
      expect(dbCheck).toBeDefined();
      expect(dbCheck!.status).toBe('ok');
      expect(dbCheck!.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(dbCheck!.details).toEqual({
        host: 'localhost',
        port: '5432',
        database: 'stellara_db',
      });
    });

    it('should include Redis check details', async () => {
      const report = await service.validate({ failOnError: false });

      const redisCheck = report.checks.find((c) => c.name === 'redis');
      expect(redisCheck).toBeDefined();
      expect(redisCheck!.status).toBe('ok');
      expect(redisCheck!.responseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should include queue config check details', async () => {
      const report = await service.validate({ failOnError: false });

      const queueCheck = report.checks.find((c) => c.name === 'queue-config');
      expect(queueCheck).toBeDefined();
      expect(queueCheck!.status).toBe('ok');
      expect(queueCheck!.details).toEqual(
        expect.objectContaining({
          redisHost: 'localhost',
          redisPort: 6379,
          queueDb: 1,
          queues: expect.objectContaining({
            'deploy-contract': expect.objectContaining({ concurrency: 2 }),
            'process-tts': expect.objectContaining({ concurrency: 4 }),
            'index-market-news': expect.objectContaining({ concurrency: 3 }),
          }),
        }),
      );
    });

    it('should include timestamp and totalTimeMs', async () => {
      const report = await service.validate({ failOnError: false });

      expect(report.timestamp).toBeDefined();
      expect(report.totalTimeMs).toBeGreaterThanOrEqual(0);
    });

    describe('database check', () => {
      it('should fail when database query throws', async () => {
        (dataSource.query as jest.Mock).mockRejectedValue(
          new Error('ECONNREFUSED'),
        );

        const report = await service.validate({ failOnError: false });

        const dbCheck = report.checks.find((c) => c.name === 'database');
        expect(dbCheck!.status).toBe('error');
        expect(dbCheck!.message).toContain('ECONNREFUSED');
      });

      it('should fail when database query times out', async () => {
        // Make the query hang indefinitely
        (dataSource.query as jest.Mock).mockImplementation(
          () => new Promise(() => {}),
        );

        const report = await service.validate({
          timeoutMs: 100,
          failOnError: false,
        });

        const dbCheck = report.checks.find((c) => c.name === 'database');
        expect(dbCheck!.status).toBe('error');
        expect(dbCheck!.message).toContain('timed out');
      });

      it('should throw when failOnError is true and DB is down', async () => {
        (dataSource.query as jest.Mock).mockRejectedValue(
          new Error('ECONNREFUSED'),
        );

        await expect(
          service.validate({ failOnError: true }),
        ).rejects.toThrow('Startup validation failed');
      });
    });

    describe('redis check', () => {
      it('should fail when Redis connect throws', async () => {
        mockRedisClient.connect.mockRejectedValue(
          new Error('Redis connection refused'),
        );

        const report = await service.validate({ failOnError: false });

        const redisCheck = report.checks.find((c) => c.name === 'redis');
        expect(redisCheck!.status).toBe('error');
        expect(redisCheck!.message).toContain('Redis connection refused');
      });

      it('should fail when Redis PING times out', async () => {
        // Connect succeeds, but PING hangs
        mockRedisClient.connect.mockResolvedValue(undefined);
        mockRedisClient.ping.mockImplementation(() => new Promise(() => {}));

        const report = await service.validate({
          timeoutMs: 100,
          failOnError: false,
        });

        const redisCheck = report.checks.find((c) => c.name === 'redis');
        expect(redisCheck!.status).toBe('error');
        expect(redisCheck!.message).toContain('timed out');
      });

      it('should fail startup when Redis is down', async () => {
        mockRedisClient.connect.mockRejectedValue(
          new Error('Connection refused'),
        );

        await expect(service.validate({ failOnError: true })).rejects.toThrow(
          'redis: Connection refused',
        );
      });

      it('should pass overall when only Redis is down and DB is healthy', async () => {
        mockRedisClient.connect.mockRejectedValue(
          new Error('Connection refused'),
        );

        await expect(service.validate({ failOnError: true })).rejects.toThrow(
          'redis: Connection refused',
        );
      });
    });

    describe('queue config check', () => {
      it('should fail when REDIS_URL and REDIS_HOST are both missing', async () => {
        const configWithoutRedis: Record<string, string | undefined> = {
          ...defaultConfig,
          REDIS_URL: undefined,
          REDIS_HOST: undefined,
        };
        (configService.get as jest.Mock).mockImplementation((key: string) => {
          return configWithoutRedis[key];
        });

        const report = await service.validate({ failOnError: false });

        const queueCheck = report.checks.find((c) => c.name === 'queue-config');
        expect(queueCheck!.status).toBe('error');
        expect(queueCheck!.message).toContain('requires REDIS_URL or REDIS_HOST');
      });

      it('should fail for invalid queue concurrency values', async () => {
        (configService.get as jest.Mock).mockImplementation((key: string) => {
          if (key === 'QUEUE_DEPLOY_CONTRACT_CONCURRENCY') return '100';
          return defaultConfig[key];
        });

        const report = await service.validate({ failOnError: false });

        const queueCheck = report.checks.find((c) => c.name === 'queue-config');
        expect(queueCheck!.status).toBe('error');
        expect(queueCheck!.message).toContain('must be between 1 and 50');
      });

      it('should use default concurrency values when not set', async () => {
        (configService.get as jest.Mock).mockImplementation((key: string) => {
          if (
            key === 'QUEUE_DEPLOY_CONTRACT_CONCURRENCY' ||
            key === 'QUEUE_PROCESS_TTS_CONCURRENCY' ||
            key === 'QUEUE_INDEX_MARKET_NEWS_CONCURRENCY'
          ) {
            return undefined;
          }
          return defaultConfig[key];
        });

        const report = await service.validate({ failOnError: false });

        const queueCheck = report.checks.find((c) => c.name === 'queue-config');
        expect(queueCheck!.status).toBe('ok');
        const queues = (queueCheck!.details as any).queues;
        expect(queues['deploy-contract'].concurrency).toBe(2);
        expect(queues['process-tts'].concurrency).toBe(4);
        expect(queues['index-market-news'].concurrency).toBe(3);
      });

      it('should use REDIS_HOST when REDIS_URL is not set', async () => {
        (configService.get as jest.Mock).mockImplementation((key: string) => {
          if (key === 'REDIS_URL') return undefined;
          if (key === 'REDIS_HOST') return 'custom-redis-host';
          return defaultConfig[key];
        });

        const report = await service.validate({ failOnError: false });

        const queueCheck = report.checks.find((c) => c.name === 'queue-config');
        expect(queueCheck!.status).toBe('ok');
        expect((queueCheck!.details as any).redisHost).toBe('custom-redis-host');
      });
    });

    describe('overall report', () => {
      it('should report success when DB and queue config are ok', async () => {
        mockRedisClient.connect.mockRejectedValue(
          new Error('Redis down'),
        );

        const report = await service.validate({ failOnError: false });

        // DB ok, Redis error, queue config ok
        expect(report.checks.filter((c) => c.status === 'ok')).toHaveLength(2);
        expect(report.checks.filter((c) => c.status === 'error')).toHaveLength(1);
      });

      it('should report overall failure when DB is down', async () => {
        (dataSource.query as jest.Mock).mockRejectedValue(
          new Error('DB down'),
        );

        const report = await service.validate({ failOnError: false });

        expect(report.success).toBe(false);
      });
    });
  });
});
