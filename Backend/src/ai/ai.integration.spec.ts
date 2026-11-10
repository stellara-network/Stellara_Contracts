import { Test, TestingModule } from '@nestjs/testing';
import { AiService } from './ai.service';
import { AiCacheService } from './cache/ai-cache.service';
import { QuotaService } from './quota/quota.service';
import { FallbackProvider } from './providers/fallback.provider';
import { OpenAiProvider } from './providers/openai.provider';
import { AI_PROVIDER, AI_FALLBACK_PROVIDER } from './ai.provider';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import axios from 'axios';

describe('AI Provider Integration', () => {
  let service: AiService;
  let openAiProvider: OpenAiProvider;
  let cacheService: AiCacheService;
  let quotaService: QuotaService;

  const mockConfig = {
    get: jest.fn((key: string) => {
      if (key === 'OPENAI_API_KEY') return 'test-key';
      if (key === 'AI_TIMEOUT_MS') return 5000;
      if (key === 'AI_MAX_REQUESTS') return 1000;
      if (key === 'AI_MONTHLY_TOKEN_BUDGET') return 500000;
      if (key === 'AI_MAX_TOKENS_PER_REQUEST') return 8000;
      return undefined;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiService,
        AiCacheService,
        QuotaService,
        OpenAiProvider,
        FallbackProvider,
        { provide: 'REDIS_CLIENT', useValue: null },
        { provide: ConfigService, useValue: mockConfig },
        { provide: AI_PROVIDER, useExisting: OpenAiProvider },
        { provide: AI_FALLBACK_PROVIDER, useExisting: FallbackProvider },
      ],
    }).compile();

    service = module.get<AiService>(AiService);
    openAiProvider = module.get<OpenAiProvider>(OpenAiProvider);
    cacheService = module.get<AiCacheService>(AiCacheService);
    quotaService = module.get<QuotaService>(QuotaService);
  });

  afterEach(() => jest.clearAllMocks());

  it('returns response from primary provider', async () => {
    jest
      .spyOn(openAiProvider, 'generate')
      .mockResolvedValueOnce({ response: 'Hello', tokensUsed: 10 });

    const result = await service.handlePrompt({
      prompt: 'Hi',
      userId: undefined,
    });

    expect(result.response).toBe('Hello');
    expect(result.cached).toBe(false);
  });

  it('falls back to cache when primary fails', async () => {
    jest
      .spyOn(openAiProvider, 'generate')
      .mockRejectedValue(new Error('API down'));
    const cacheKey = cacheService.buildKey('test', 'fallback');
    await cacheService.set(cacheKey, 'cached response');

    const result = await service.handlePrompt({
      prompt: 'test',
      userId: undefined,
    });

    expect(result.response).toBeDefined();
  });

  it('returns degraded response when all providers fail', async () => {
    jest
      .spyOn(openAiProvider, 'generate')
      .mockRejectedValue(new Error('API down'));

    const result = await service.handlePrompt({
      prompt: 'unique-prompt-no-cache-xyz',
      userId: undefined,
    });

    expect(result.response).toContain('unavailable');
  });

  it('opens circuit after 5 consecutive failures', async () => {
    jest.spyOn(axios, 'post').mockRejectedValue(new Error('fail'));

    for (let i = 0; i < 5; i++) {
      try {
        await openAiProvider.generate('test');
      } catch {
        // Expected failure for circuit breaker testing
      }
    }

    expect(openAiProvider.getCircuitState()).toBe('open');
  });

  it('returns cached result on second identical prompt', async () => {
    jest
      .spyOn(openAiProvider, 'generate')
      .mockResolvedValue({ response: 'cached-answer', tokensUsed: 5 });

    await service.handlePrompt({ prompt: 'repeat-me', userId: undefined });
    const second = await service.handlePrompt({
      prompt: 'repeat-me',
      userId: undefined,
    });

    expect(second.cached).toBe(true);
  });

  describe('AI Request Deduplication', () => {
    it('coalesces concurrent identical in-flight requests into a single provider call', async () => {
      let callCount = 0;
      jest.spyOn(openAiProvider, 'generate').mockImplementation(async () => {
        callCount++;
        // Simulate latency to allow concurrent calls to arrive
        await new Promise((r) => setTimeout(r, 50));
        return { response: 'deduped-answer', tokensUsed: 15 };
      });

      const [res1, res2, res3] = await Promise.all([
        service.handlePrompt({ prompt: 'concurrent-query' }),
        service.handlePrompt({ prompt: 'concurrent-query' }),
        service.handlePrompt({ prompt: 'concurrent-query' }),
      ]);

      expect(callCount).toBe(1);
      expect(res1.response).toBe('deduped-answer');
      expect(res2.response).toBe('deduped-answer');
      expect(res3.response).toBe('deduped-answer');

      // The first execution did the generation, concurrent ones were deduped
      const dedupedCount = [res1.deduped, res2.deduped, res3.deduped].filter(
        Boolean,
      ).length;
      expect(dedupedCount).toBe(2);

      // In-flight map is cleaned up
      expect(cacheService.getInflightCount()).toBe(0);
    });

    it('cleans up in-flight request map on provider error', async () => {
      jest
        .spyOn(openAiProvider, 'generate')
        .mockRejectedValue(new Error('Temporary model failure'));

      const key = cacheService.buildKey('error-prompt', 'gpt-4');
      await service.handlePrompt({ prompt: 'error-prompt' });

      expect(cacheService.isInflight(key)).toBe(false);
      expect(cacheService.getInflightCount()).toBe(0);
    });
  });

  describe('Budget Enforcement and Token Controls', () => {
    it('blocks request when estimated tokens exceed single-request threshold', async () => {
      await expect(
        service.handlePrompt({
          prompt: 'huge-prompt',
          userId: 'user-1',
          estimatedTokens: 9000, // exceeds 8000 maxTokensPerRequest
        }),
      ).rejects.toThrow(ForbiddenException);

      try {
        await service.handlePrompt({
          prompt: 'huge-prompt',
          userId: 'user-1',
          estimatedTokens: 9000,
        });
      } catch (err: unknown) {
        if (err instanceof ForbiddenException) {
          expect(err.getResponse()).toEqual(
            expect.objectContaining({
              error: 'RequestBudgetExceeded',
            }),
          );
        }
      }
    });

    it('blocks request when monthly token budget is exceeded', async () => {
      const userId = 'heavy-user-1';
      // Record usage up to 500,000 tokens
      await quotaService.recordUsage(userId, 500000);

      await expect(
        service.handlePrompt({
          prompt: 'next-query',
          userId,
          estimatedTokens: 50,
        }),
      ).rejects.toThrow(ForbiddenException);

      try {
        await service.handlePrompt({
          prompt: 'next-query',
          userId,
        });
      } catch (err: unknown) {
        if (err instanceof ForbiddenException) {
          expect(err.getResponse()).toEqual(
            expect.objectContaining({
              error: 'BudgetExceeded',
            }),
          );
        }
      }
    });

    it('blocks request when monthly request count is exceeded', async () => {
      const userId = 'chatty-user-1';
      for (let i = 0; i < 1000; i++) {
        await quotaService.recordUsage(userId, 1);
      }

      await expect(
        service.handlePrompt({
          prompt: 'one-more-query',
          userId,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('enforces custom per-user budgets', async () => {
      const userId = 'limited-tier-user';
      quotaService.setUserBudget(userId, {
        maxRequests: 5,
        maxMonthlyTokens: 1000,
        maxTokensPerRequest: 200,
      });

      // Request exceeding custom single-request limit of 200 tokens
      await expect(
        service.handlePrompt({
          prompt: 'custom-check',
          userId,
          estimatedTokens: 250,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('returns comprehensive quota usage details', async () => {
      const userId = 'audit-user';
      await quotaService.recordUsage(userId, 500);

      const usage = await quotaService.getQuotaUsage(userId);
      expect(usage.userId).toBe(userId);
      expect(usage.requestCount).toBe(1);
      expect(usage.tokenCount).toBe(500);
      expect(usage.maxMonthlyTokens).toBe(500000);
      expect(usage.remainingTokens).toBe(499500);
      expect(usage.isBudgetExceeded).toBe(false);
    });
  });

  describe('Cache Invalidation Rules', () => {
    it('invalidates cache for a specific prompt', async () => {
      jest
        .spyOn(openAiProvider, 'generate')
        .mockResolvedValue({ response: 'v1', tokensUsed: 10 });
      await service.handlePrompt({ prompt: 'invalidate-me' });

      // First cached hit
      const cachedHit = await service.handlePrompt({ prompt: 'invalidate-me' });
      expect(cachedHit.cached).toBe(true);

      // Invalidate
      const deleted = await cacheService.invalidatePrompt('invalidate-me');
      expect(deleted).toBe(true);

      // Next query is fresh
      jest
        .spyOn(openAiProvider, 'generate')
        .mockResolvedValue({ response: 'v2', tokensUsed: 10 });
      const freshResult = await service.handlePrompt({
        prompt: 'invalidate-me',
      });
      expect(freshResult.cached).toBe(false);
      expect(freshResult.response).toBe('v2');
    });

    it('invalidates cache by glob pattern', async () => {
      await cacheService.set(cacheService.buildKey('p1', 'gpt-4'), 'ans1');
      await cacheService.set(cacheService.buildKey('p2', 'gpt-4'), 'ans2');
      await cacheService.set(cacheService.buildKey('p3', 'claude-3'), 'ans3');

      const deletedCount = await cacheService.invalidateByPattern('ai:gpt-4:*');
      expect(deletedCount).toBe(2);

      expect(
        await cacheService.get(cacheService.buildKey('p1', 'gpt-4')),
      ).toBeNull();
      expect(
        await cacheService.get(cacheService.buildKey('p2', 'gpt-4')),
      ).toBeNull();
      expect(
        await cacheService.get(cacheService.buildKey('p3', 'claude-3')),
      ).toBe('ans3');
    });

    it('invalidates cache by model name', async () => {
      await cacheService.set(cacheService.buildKey('m1', 'claude-3'), 'resp1');
      const count = await cacheService.invalidateModel('claude-3');
      expect(count).toBe(1);
      expect(
        await cacheService.get(cacheService.buildKey('m1', 'claude-3')),
      ).toBeNull();
    });

    it('clears all cache entries on clear()', async () => {
      await cacheService.set('ai:test:1', 'val1');
      await cacheService.set('ai:test:2', 'val2');

      await cacheService.clear();

      expect(await cacheService.get('ai:test:1')).toBeNull();
      expect(await cacheService.get('ai:test:2')).toBeNull();
      expect(cacheService.size()).toBe(0);
    });
  });
});
