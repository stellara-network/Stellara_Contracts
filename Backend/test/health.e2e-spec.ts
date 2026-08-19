import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { RedisService } from '../src/redis/redis.service';
import { StellarEventMonitorService } from '../src/stellar-monitor/services/stellar-event-monitor.service';
import { HealthController } from '../src/health/health.controller';
import { DatabaseHealthIndicator } from '../src/health/database-health.indicator';
import { RedisHealthIndicator } from '../src/health/redis-health.indicator';
import { QueueHealthIndicator } from '../src/health/queue-health.indicator';
import { AuthHealthIndicator } from '../src/health/auth-health.indicator';

describe('HealthModule (e2e)', () => {
  let app: INestApplication<App>;

  const mockDatabaseHealthIndicator = {
    isHealthy: jest.fn(),
  };

  const mockRedisHealthIndicator = {
    isHealthy: jest.fn(),
  };

  const mockQueueHealthIndicator = {
    isHealthy: jest.fn(),
  };

  const mockAuthHealthIndicator = {
    isHealthy: jest.fn(),
  };

  const mockStellarMonitorService = {
    getStatus: jest.fn(),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: DatabaseHealthIndicator,
          useValue: mockDatabaseHealthIndicator,
        },
        { provide: RedisHealthIndicator, useValue: mockRedisHealthIndicator },
        { provide: QueueHealthIndicator, useValue: mockQueueHealthIndicator },
        { provide: AuthHealthIndicator, useValue: mockAuthHealthIndicator },
        {
          provide: StellarEventMonitorService,
          useValue: mockStellarMonitorService,
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('/health/live (GET)', () => {
    it('should return 200 with status ok and timestamp', () => {
      return request(app.getHttpServer())
        .get('/health/live')
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe('ok');
          expect(res.body.timestamp).toBeDefined();
          expect(typeof res.body.timestamp).toBe('string');
        });
    });
  });

  describe('/health/ready (GET)', () => {
    it('should return 200 when all dependencies are healthy', async () => {
      mockDatabaseHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 5,
      });
      mockRedisHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 2,
      });
      mockQueueHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 3,
        queueCount: 3,
        failedCount: 0,
      });
      mockAuthHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 1,
      });
      mockStellarMonitorService.getStatus.mockReturnValue({
        isMonitoring: true,
        lastLedgerSequence: 12345,
        horizonUrl: 'https://horizon-testnet.stellar.org',
      });

      const res = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(200);

      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
      expect(res.body.responseTimeMs).toBeDefined();
      expect(res.body.checks.database).toMatchObject({ status: 'ok' });
      expect(res.body.checks.redis).toMatchObject({ status: 'ok' });
      expect(res.body.checks.queue).toMatchObject({
        status: 'ok',
        queueCount: 3,
        failedCount: 0,
      });
      expect(res.body.checks.auth).toMatchObject({ status: 'ok' });
      expect(res.body.checks.stellarMonitor).toMatchObject({
        status: 'ok',
        isMonitoring: true,
        lastLedgerSequence: 12345,
      });
    });

    it('should return 503 when database is down', async () => {
      mockDatabaseHealthIndicator.isHealthy.mockResolvedValue({
        status: 'error',
        message: 'DB connection failed',
        responseTimeMs: 100,
      });
      mockRedisHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 2,
      });
      mockQueueHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 3,
        queueCount: 3,
        failedCount: 0,
      });
      mockAuthHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 1,
      });
      mockStellarMonitorService.getStatus.mockReturnValue({
        isMonitoring: true,
        lastLedgerSequence: 12345,
        horizonUrl: 'https://horizon-testnet.stellar.org',
      });

      const res = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);

      expect(res.body.status).toBe('error');
      expect(res.body.checks.database.status).toBe('error');
      expect(res.body.checks.database.message).toBe('DB connection failed');
      expect(res.body.checks.redis.status).toBe('ok');
    });

    it('should return 503 when redis is down', async () => {
      mockDatabaseHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 5,
      });
      mockRedisHealthIndicator.isHealthy.mockResolvedValue({
        status: 'error',
        message: 'Redis connection refused',
        responseTimeMs: 100,
      });
      mockQueueHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 3,
        queueCount: 3,
        failedCount: 0,
      });
      mockAuthHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 1,
      });
      mockStellarMonitorService.getStatus.mockReturnValue({
        isMonitoring: true,
        lastLedgerSequence: 12345,
        horizonUrl: 'https://horizon-testnet.stellar.org',
      });

      const res = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);

      expect(res.body.status).toBe('error');
      expect(res.body.checks.database.status).toBe('ok');
      expect(res.body.checks.redis.status).toBe('error');
      expect(res.body.checks.redis.message).toBe('Redis connection refused');
    });

    it('should return 503 when queue is down', async () => {
      mockDatabaseHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 5,
      });
      mockRedisHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 2,
      });
      mockQueueHealthIndicator.isHealthy.mockResolvedValue({
        status: 'error',
        message: 'Bull connection refused',
        responseTimeMs: 100,
      });
      mockAuthHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 1,
      });
      mockStellarMonitorService.getStatus.mockReturnValue({
        isMonitoring: true,
        lastLedgerSequence: 12345,
        horizonUrl: 'https://horizon-testnet.stellar.org',
      });

      const res = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);

      expect(res.body.status).toBe('error');
      expect(res.body.checks.queue.status).toBe('error');
      expect(res.body.checks.queue.message).toBe('Bull connection refused');
    });

    it('should return 503 when auth is down', async () => {
      mockDatabaseHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 5,
      });
      mockRedisHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 2,
      });
      mockQueueHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 3,
        queueCount: 3,
        failedCount: 0,
      });
      mockAuthHealthIndicator.isHealthy.mockResolvedValue({
        status: 'error',
        message: 'JWT_SECRET not configured',
        responseTimeMs: 1,
      });
      mockStellarMonitorService.getStatus.mockReturnValue({
        isMonitoring: true,
        lastLedgerSequence: 12345,
        horizonUrl: 'https://horizon-testnet.stellar.org',
      });

      const res = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);

      expect(res.body.status).toBe('error');
      expect(res.body.checks.auth.status).toBe('error');
      expect(res.body.checks.auth.message).toBe('JWT_SECRET not configured');
    });

    it('should return 503 when both database and redis are down', async () => {
      mockDatabaseHealthIndicator.isHealthy.mockResolvedValue({
        status: 'error',
        message: 'DB timeout',
        responseTimeMs: 5000,
      });
      mockRedisHealthIndicator.isHealthy.mockResolvedValue({
        status: 'error',
        message: 'Redis timeout',
        responseTimeMs: 5000,
      });
      mockQueueHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 3,
        queueCount: 3,
        failedCount: 0,
      });
      mockAuthHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 1,
      });
      mockStellarMonitorService.getStatus.mockReturnValue({
        isMonitoring: true,
        lastLedgerSequence: 12345,
        horizonUrl: 'https://horizon-testnet.stellar.org',
      });

      const res = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);

      expect(res.body.status).toBe('error');
      expect(res.body.checks.database.status).toBe('error');
      expect(res.body.checks.redis.status).toBe('error');
    });

    it('should return 503 when all dependencies are down', async () => {
      mockDatabaseHealthIndicator.isHealthy.mockResolvedValue({
        status: 'error',
        message: 'DB timeout',
        responseTimeMs: 5000,
      });
      mockRedisHealthIndicator.isHealthy.mockResolvedValue({
        status: 'error',
        message: 'Redis timeout',
        responseTimeMs: 5000,
      });
      mockQueueHealthIndicator.isHealthy.mockResolvedValue({
        status: 'error',
        message: 'Queue timeout',
        responseTimeMs: 5000,
      });
      mockAuthHealthIndicator.isHealthy.mockResolvedValue({
        status: 'error',
        message: 'JWT secret missing',
        responseTimeMs: 0,
      });
      mockStellarMonitorService.getStatus.mockReturnValue({
        isMonitoring: false,
        lastLedgerSequence: undefined,
        horizonUrl: 'https://horizon-testnet.stellar.org',
      });

      const res = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);

      expect(res.body.status).toBe('error');
      expect(res.body.checks.database.status).toBe('error');
      expect(res.body.checks.redis.status).toBe('error');
      expect(res.body.checks.queue.status).toBe('error');
      expect(res.body.checks.auth.status).toBe('error');
    });

    it('should include responseTimeMs for each dependency check', async () => {
      mockDatabaseHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 5,
      });
      mockRedisHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 2,
      });
      mockQueueHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 3,
        queueCount: 3,
        failedCount: 0,
      });
      mockAuthHealthIndicator.isHealthy.mockResolvedValue({
        status: 'ok',
        responseTimeMs: 1,
      });
      mockStellarMonitorService.getStatus.mockReturnValue({
        isMonitoring: true,
        lastLedgerSequence: 12345,
        horizonUrl: 'https://horizon-testnet.stellar.org',
      });

      const res = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(200);

      expect(res.body.responseTimeMs).toBeDefined();
      expect(typeof res.body.responseTimeMs).toBe('number');
      expect(res.body.checks.database.responseTimeMs).toBeDefined();
      expect(res.body.checks.redis.responseTimeMs).toBeDefined();
      expect(res.body.checks.queue.responseTimeMs).toBeDefined();
      expect(res.body.checks.auth.responseTimeMs).toBeDefined();
    });
  });
});
