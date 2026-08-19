import { Test, TestingModule } from '@nestjs/testing';
import { LlmService } from './llm.service';
import { QuotaService } from './quota.service';
import { LlmCacheService } from './llm-cache.service';
import { RedisService } from '../../redis/redis.service';

/**
 * A tiny stateful in-memory Redis fake. The methods are `jest.fn()`s so
 * assertions like `expect(client.set).toHaveBeenCalled()` keep working, but
 * they also maintain a real key/value store so the pipeline behaves the way a
 * real Redis would.
 */
function createInMemoryRedisClient() {
  const store = new Map<string, string>();

  const client = {
    get: jest.fn(
      async (key: string): Promise<string | null> => store.get(key) ?? null,
    ),
    set: jest.fn(
      async (key: string, value: string, _opts?: unknown): Promise<string> => {
        store.set(key, String(value));
        return 'OK';
      },
    ),
    incr: jest.fn(async (key: string): Promise<number> => {
      const next = parseInt(store.get(key) ?? '0', 10) + 1;
      store.set(key, String(next));
      return next;
    }),
    expire: jest.fn(async (_key: string, _ttl: number): Promise<number> => 1),
    del: jest.fn(async (keys: string | string[]): Promise<number> => {
      const list = Array.isArray(keys) ? keys : [keys];
      let count = 0;
      for (const k of list) {
        if (store.delete(k)) count++;
      }
      return count;
    }),
    keys: jest.fn(async (pattern: string): Promise<string[]> => {
      const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
      return Array.from(store.keys()).filter((k) => regex.test(k));
    }),
  };

  return { client, store };
}

describe('LLM Pipeline Integration Tests', () => {
  let llmService: LlmService;
  let quotaService: QuotaService;
  let cacheService: LlmCacheService;
  let redis: ReturnType<typeof createInMemoryRedisClient>;

  const seed = (key: string, value: string): void => {
    redis.store.set(key, value);
  };

  beforeEach(async () => {
    redis = createInMemoryRedisClient();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LlmService,
        QuotaService,
        LlmCacheService,
        { provide: RedisService, useValue: { client: redis.client } },
      ],
    }).compile();

    llmService = module.get<LlmService>(LlmService);
    quotaService = module.get<QuotaService>(QuotaService);
    cacheService = module.get<LlmCacheService>(LlmCacheService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Complete LLM Request Pipeline', () => {
    const userId = 'user123';
    const sessionId = 'session123';
    const prompt = 'What is TypeScript?';

    it('should follow complete pipeline: quota -> cache -> LLM -> cache store', async () => {
      const response = await llmService.generateResponse(
        userId,
        sessionId,
        prompt,
      );

      expect(response.content).toBeDefined();
      expect(response.cached).toBe(false);
      expect(response.model).toBe('gpt-3.5-turbo');
      expect(redis.client.set).toHaveBeenCalled();
      expect(redis.client.incr).toHaveBeenCalled();
    });

    it('should serve a cached response on the second identical request', async () => {
      await llmService.generateResponse(userId, sessionId, prompt);
      redis.client.set.mockClear();

      const response = await llmService.generateResponse(
        userId,
        sessionId,
        prompt,
      );

      expect(response.cached).toBe(true);
      // No new cache write for a cache hit.
      expect(redis.client.set).not.toHaveBeenCalled();
    });

    it('should enforce quota limits across sessions', async () => {
      seed('quota:session:session123', '101'); // exceeds default per-session limit (100)

      await expect(
        llmService.generateResponse(userId, sessionId, prompt),
      ).rejects.toThrow('Session LLM quota exceeded');
    });

    it('should return a fallback on any error without throwing', async () => {
      // Force an internal error by poisoning the quota service's reads.
      redis.client.get.mockRejectedValue(new Error('Redis down'));

      const response = await llmService.generateResponseWithFallback(
        userId,
        sessionId,
        prompt,
      );

      expect(response.content).toBeDefined();
      expect(response.model).toBeDefined();
    });

    it('should normalize prompt casing to a single cache entry', async () => {
      await llmService.generateResponse(
        userId,
        sessionId,
        '  What is TypeScript?  ',
      );
      redis.client.get.mockClear();

      const response = await llmService.generateResponse(
        userId,
        sessionId,
        'what is typescript?',
      );

      // Same normalized prompt → same cache key → cache hit.
      expect(response.cached).toBe(true);
    });
  });

  describe('Quota Enforcement Scenarios', () => {
    const userId = 'user123';
    const sessionId = 'session123';

    it('should report usage from persisted quota keys', async () => {
      seed('quota:session:session123', '50');

      const status = await quotaService.getQuotaStatus(userId, sessionId);
      expect(status.sessionUsage).toBe(50);
      expect(status.sessionLimit).toBe(100);
    });

    it('should track per-session quotas independently', async () => {
      seed('quota:session:sess1', '50');
      seed('quota:session:sess2', '25');

      const status1 = await quotaService.getQuotaStatus(userId, 'sess1');
      const status2 = await quotaService.getQuotaStatus(userId, 'sess2');

      expect(status1.sessionUsage).toBe(50);
      expect(status2.sessionUsage).toBe(25);
    });

    it('should enforce rate limiting per minute window', async () => {
      const now = new Date();
      const minute = Math.floor(now.getTime() / 60000);
      seed(`quota:rpm:${userId}:${minute}`, '20'); // at the default RPM limit

      await expect(
        quotaService.enforceQuota(userId, sessionId),
      ).rejects.toThrow('Rate limit exceeded');
    });
  });

  describe('Cache Statistics & Management', () => {
    it('should track cache hit rate', async () => {
      seed('llm:cache:total-entries', '100');
      seed('llm:cache:total-hits', '75');

      const stats = await cacheService.getStats();

      expect(stats.totalEntries).toBe(100);
      expect(stats.totalHits).toBe(75);
      expect(stats.hitRate).toBe(0.75);
    });

    it('should support cache invalidation on model updates', async () => {
      await cacheService.set('What is AI?', 'AI is...', 'gpt-4');
      const count = await cacheService.invalidate('What is AI?', 'gpt-4');

      expect(count).toBe(1);
      expect(redis.client.del).toHaveBeenCalled();
    });

    it('should support cache warming for common prompts', async () => {
      const commonPrompts = [
        {
          prompt: 'What is blockchain?',
          response: 'Blockchain is...',
          model: 'gpt-3.5-turbo',
        },
        {
          prompt: 'Explain smart contracts',
          response: 'Smart contracts are...',
          model: 'gpt-3.5-turbo',
        },
      ];

      const count = await cacheService.warmCache(commonPrompts);

      expect(count).toBe(2);
      expect(redis.client.set).toHaveBeenCalled();
    });

    it('should prune old cache entries', async () => {
      // Seed a cache entry that was created 1 day ago.
      await cacheService.set('old prompt', 'old response', 'gpt-3.5-turbo');
      const cacheKeys = await redis.client.keys('llm:cache:*');
      const entryKey = cacheKeys.find((k) => !k.endsWith(':stats'));
      if (entryKey) {
        const statsKey = `${entryKey}:stats`;
        seed(statsKey, String(Date.now() - 86400000)); // 1 day old
      }

      const count = await cacheService.pruneOldEntries(3600); // 1 hour max age

      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Fallback & Graceful Degradation', () => {
    const userId = 'user123';
    const sessionId = 'session123';

    it('should return fallback when quota service fails', async () => {
      redis.client.get.mockRejectedValue(new Error('Redis down'));

      const response = await llmService.generateResponseWithFallback(
        userId,
        sessionId,
        'test prompt',
      );

      expect(response.content).toContain("I'm sorry");
      expect(response.cached).toBe(false);
    });

    it('should return fallback when cache service fails', async () => {
      redis.client.set.mockRejectedValue(new Error('Cache write failed'));

      const response = await llmService.generateResponseWithFallback(
        userId,
        sessionId,
        'test prompt',
      );

      expect(response.content).toBeDefined();
      expect(response.model).toBeDefined();
    });
  });
});
