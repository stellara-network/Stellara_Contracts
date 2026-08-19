import { Test, TestingModule } from '@nestjs/testing';
import { QuotaService } from './quota.service';
import { RedisService } from '../../redis/redis.service';
import { HttpException, HttpStatus } from '@nestjs/common';

describe('QuotaService', () => {
  let service: QuotaService;
  let redisService: RedisService;

  const mockRedisClient = {
    get: jest.fn(),
    set: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    del: jest.fn(),
    keys: jest.fn(),
  };

  const mockRedisService = {
    client: mockRedisClient,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuotaService,
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
      ],
    }).compile();

    service = module.get<QuotaService>(QuotaService);
    redisService = module.get<RedisService>(RedisService);
    jest.resetAllMocks();
  });

  describe('enforceQuota', () => {
    const userId = 'user123';
    const sessionId = 'session123';

    it('should allow request when within all quotas', async () => {
      mockRedisClient.get.mockResolvedValue(null); // No usage, no custom quota

      const status = await service.enforceQuota(userId, sessionId);

      expect(status.monthlyUsage).toBe(0);
      expect(status.sessionUsage).toBe(0);
      expect(status.requestsThisMinute).toBe(0);
    });

    it('should throw when monthly quota exceeded', async () => {
      mockRedisClient.get.mockResolvedValue('1001'); // Exceeds default monthly limit
      mockRedisClient.incr.mockResolvedValue(1001);

      await expect(service.enforceQuota(userId, sessionId)).rejects.toThrow(
        HttpException,
      );
      await expect(service.enforceQuota(userId, sessionId)).rejects.toThrow();
    });

    it('should throw when session quota exceeded', async () => {
      mockRedisClient.get.mockResolvedValueOnce('100'); // Monthly OK
      mockRedisClient.get.mockResolvedValueOnce('101'); // Session exceeds default limit
      mockRedisClient.incr.mockResolvedValueOnce(100);
      mockRedisClient.incr.mockResolvedValueOnce(101);

      await expect(service.enforceQuota(userId, sessionId)).rejects.toThrow();
    });

    it('should throw when rate limit exceeded', async () => {
      mockRedisClient.get.mockResolvedValueOnce('100'); // Monthly OK
      mockRedisClient.get.mockResolvedValueOnce('50'); // Session OK
      mockRedisClient.get.mockResolvedValueOnce('21'); // RPM exceeds default limit
      mockRedisClient.incr.mockResolvedValueOnce(100);
      mockRedisClient.incr.mockResolvedValueOnce(50);
      mockRedisClient.incr.mockResolvedValueOnce(21);

      await expect(service.enforceQuota(userId, sessionId)).rejects.toThrow();
    });
  });

  describe('getQuotaStatus', () => {
    const userId = 'user123';
    const sessionId = 'session123';

    it('should return current quota status', async () => {
      mockRedisClient.get.mockResolvedValueOnce('50'); // Monthly
      mockRedisClient.get.mockResolvedValueOnce('25'); // Session
      mockRedisClient.get.mockResolvedValueOnce('10'); // RPM

      const status = await service.getQuotaStatus(userId, sessionId);

      expect(status.monthlyUsage).toBe(50);
      expect(status.monthlyLimit).toBe(1000);
      expect(status.sessionUsage).toBe(25);
      expect(status.requestsThisMinute).toBe(10);
    });

    it('should handle missing values as zero', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const status = await service.getQuotaStatus(userId, sessionId);

      expect(status.monthlyUsage).toBe(0);
      expect(status.sessionUsage).toBe(0);
      expect(status.requestsThisMinute).toBe(0);
    });
  });

  describe('recordRequest', () => {
    const userId = 'user123';
    const sessionId = 'session123';

    it('should increment all quota counters', async () => {
      mockRedisClient.incr.mockResolvedValue(1);

      await service.recordRequest(userId, sessionId);

      expect(mockRedisClient.incr).toHaveBeenCalledTimes(3);
      expect(mockRedisClient.expire).toHaveBeenCalled();
    });
  });

  describe('resetUserQuota', () => {
    const userId = 'user123';

    it('should delete all user quota keys', async () => {
      mockRedisClient.keys.mockResolvedValue(['quota:monthly:user123:2024-1']);
      mockRedisClient.del.mockResolvedValue(1);

      await service.resetUserQuota(userId);

      expect(mockRedisClient.keys).toHaveBeenCalled();
      expect(mockRedisClient.del).toHaveBeenCalled();
    });

    it('should handle when no keys exist', async () => {
      mockRedisClient.keys.mockResolvedValue([]);

      await service.resetUserQuota(userId);

      expect(mockRedisClient.del).not.toHaveBeenCalled();
    });
  });

  describe('setUserMonthlyQuota', () => {
    const userId = 'user123';

    it('should set custom monthly quota', async () => {
      mockRedisClient.get.mockResolvedValue('100');
      mockRedisClient.set.mockResolvedValue('OK');

      await service.setUserMonthlyQuota(userId, 500);

      expect(mockRedisClient.set).toHaveBeenCalled();
    });
  });

  describe('getUserMonthlyQuota', () => {
    const userId = 'user123';

    it('should return custom quota if set', async () => {
      mockRedisClient.get.mockResolvedValue('500');

      const quota = await service.getUserMonthlyQuota(userId);

      expect(quota).toBe(500);
    });

    it('should return default quota if not set', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const quota = await service.getUserMonthlyQuota(userId);

      expect(quota).toBe(1000);
    });
  });

  describe('resetSessionQuota', () => {
    const sessionId = 'session123';

    it('should delete session quota key', async () => {
      mockRedisClient.del.mockResolvedValue(1);

      await service.resetSessionQuota(sessionId);

      expect(mockRedisClient.del).toHaveBeenCalled();
    });
  });
});
