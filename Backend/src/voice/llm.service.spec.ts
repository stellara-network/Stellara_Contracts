import { Test, TestingModule } from '@nestjs/testing';
import { LlmService } from './services/llm.service';
import { RedisService } from '../redis/redis.service';
import { QuotaService } from './services/quota.service';
import { LlmCacheService } from './services/llm-cache.service';
import { HttpException } from '@nestjs/common';

describe('LlmService', () => {
  let service: LlmService;
  let quotaService: {
    enforceQuota: jest.Mock;
    recordRequest: jest.Mock;
    getQuotaStatus: jest.Mock;
    resetUserQuota: jest.Mock;
  };
  let cacheService: {
    get: jest.Mock;
    set: jest.Mock;
    getStats: jest.Mock;
    invalidate: jest.Mock;
    invalidateAll: jest.Mock;
    warmCache: jest.Mock;
  };

  beforeEach(async () => {
    quotaService = {
      enforceQuota: jest.fn().mockResolvedValue({
        monthlyUsage: 0,
        monthlyLimit: 1000,
        sessionUsage: 0,
        sessionLimit: 100,
        requestsThisMinute: 0,
        requestsPerMinuteLimit: 20,
      }),
      recordRequest: jest.fn().mockResolvedValue(undefined),
      getQuotaStatus: jest.fn().mockResolvedValue({
        monthlyUsage: 0,
        monthlyLimit: 1000,
        sessionUsage: 0,
        sessionLimit: 100,
        requestsThisMinute: 0,
        requestsPerMinuteLimit: 20,
      }),
      resetUserQuota: jest.fn().mockResolvedValue(undefined),
    };

    cacheService = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      getStats: jest.fn().mockResolvedValue({
        totalEntries: 0,
        totalHits: 0,
        hitRate: 0,
        oldestEntry: null,
      }),
      invalidate: jest.fn().mockResolvedValue(0),
      invalidateAll: jest.fn().mockResolvedValue(0),
      warmCache: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LlmService,
        { provide: RedisService, useValue: { client: {} } },
        { provide: QuotaService, useValue: quotaService },
        { provide: LlmCacheService, useValue: cacheService },
      ],
    }).compile();

    service = module.get<LlmService>(LlmService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('generateResponse', () => {
    const userId = 'user123';
    const sessionId = 'session123';
    const prompt = 'Hello';
    const model = 'gpt-3.5-turbo';

    it('should return cached response if available', async () => {
      cacheService.get.mockResolvedValue('cached response');

      const result = await service.generateResponse(userId, sessionId, prompt, {
        model,
      });

      expect(result.cached).toBe(true);
      expect(result.content).toBe('cached response');
      expect(result.model).toBe(model);
      expect(cacheService.set).not.toHaveBeenCalled();
      expect(quotaService.recordRequest).not.toHaveBeenCalled();
    });

    it('should call LLM and cache response if not in cache', async () => {
      cacheService.get.mockResolvedValue(null);

      const result = await service.generateResponse(userId, sessionId, prompt, {
        model,
      });

      expect(result.cached).toBe(false);
      expect(result.content).toBeDefined();
      expect(result.model).toBe(model);
      expect(cacheService.set).toHaveBeenCalled();
      expect(quotaService.recordRequest).toHaveBeenCalled();
    });

    it('should throw error if monthly quota is exceeded', async () => {
      quotaService.enforceQuota.mockRejectedValue(
        new HttpException('Monthly quota exceeded', 429),
      );

      await expect(
        service.generateResponse(userId, sessionId, prompt),
      ).rejects.toThrow(HttpException);
    });

    it('should throw error if session quota is exceeded', async () => {
      quotaService.enforceQuota.mockRejectedValue(
        new HttpException('Session quota exceeded', 429),
      );

      await expect(
        service.generateResponse(userId, sessionId, prompt),
      ).rejects.toThrow(HttpException);
    });

    it('should respect caching preference', async () => {
      cacheService.get.mockResolvedValue(null);

      const result = await service.generateResponse(userId, sessionId, prompt, {
        useCache: false,
      });

      expect(result.content).toBeDefined();
      expect(cacheService.get).not.toHaveBeenCalled();
      expect(cacheService.set).not.toHaveBeenCalled();
    });

    it('should record quota usage by default', async () => {
      cacheService.get.mockResolvedValue(null);

      await service.generateResponse(userId, sessionId, prompt);

      expect(quotaService.recordRequest).toHaveBeenCalledWith(
        userId,
        sessionId,
      );
    });

    it('should skip quota recording if disabled', async () => {
      cacheService.get.mockResolvedValue(null);

      await service.generateResponse(userId, sessionId, prompt, {
        recordQuota: false,
      });

      expect(quotaService.recordRequest).not.toHaveBeenCalled();
    });
  });

  describe('generateResponseWithFallback', () => {
    const userId = 'user123';
    const sessionId = 'session123';
    const prompt = 'Hello';

    it('should return successful response when available', async () => {
      cacheService.get.mockResolvedValue(null);

      const result = await service.generateResponseWithFallback(
        userId,
        sessionId,
        prompt,
      );

      expect(result.content).toBeDefined();
      expect(result.content).not.toContain("I'm sorry");
    });

    it('should return fallback message on quota exceeded', async () => {
      quotaService.enforceQuota.mockRejectedValue(
        new HttpException('Quota exceeded', 429),
      );

      const result = await service.generateResponseWithFallback(
        userId,
        sessionId,
        prompt,
      );

      expect(result.content).toContain("I'm sorry");
      expect(result.cached).toBe(false);
    });

    it('should never throw exceptions', async () => {
      quotaService.enforceQuota.mockRejectedValue(new Error('Redis error'));
      quotaService.getQuotaStatus.mockRejectedValue(new Error('Redis error'));

      await expect(
        service.generateResponseWithFallback(userId, sessionId, prompt),
      ).resolves.toBeDefined();
    });
  });

  describe('getQuotaStatus', () => {
    it('should return current quota status', async () => {
      const status = await service.getQuotaStatus('user123', 'session123');

      expect(status.monthlyUsage).toBeDefined();
      expect(status.sessionUsage).toBeDefined();
      expect(status.requestsThisMinute).toBeDefined();
      expect(quotaService.getQuotaStatus).toHaveBeenCalled();
    });
  });

  describe('cache operations', () => {
    it('should get cache statistics', async () => {
      cacheService.getStats.mockResolvedValue({
        totalEntries: 100,
        totalHits: 50,
        hitRate: 0.5,
        oldestEntry: null,
      });

      const stats = await service.getCacheStats();

      expect(stats.totalEntries).toBe(100);
      expect(stats.totalHits).toBe(50);
    });

    it('should invalidate cache for specific prompt', async () => {
      cacheService.invalidate.mockResolvedValue(2);

      const count = await service.invalidateCache('prompt', 'gpt-3.5-turbo');

      expect(count).toBe(2);
      expect(cacheService.invalidate).toHaveBeenCalledWith(
        'prompt',
        'gpt-3.5-turbo',
      );
    });

    it('should invalidate all cache', async () => {
      cacheService.invalidateAll.mockResolvedValue(5);

      const count = await service.invalidateAllCache();

      expect(count).toBe(5);
    });
  });

  describe('admin operations', () => {
    it('should reset user quota', async () => {
      await expect(service.resetUserQuota('user123')).resolves.toBeUndefined();
      expect(quotaService.resetUserQuota).toHaveBeenCalledWith('user123');
    });

    it('should warm cache with entries', async () => {
      cacheService.warmCache.mockResolvedValue(2);

      const entries = [
        { prompt: 'Hello', response: 'Hi!', model: 'gpt-3.5-turbo' },
        { prompt: 'Bye', response: 'See you', model: 'gpt-3.5-turbo' },
      ];

      const count = await service.warmCache(entries);

      expect(count).toBe(2);
      expect(cacheService.warmCache).toHaveBeenCalledWith(entries);
    });
  });
});
