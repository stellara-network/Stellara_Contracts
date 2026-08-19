import { Test, TestingModule } from '@nestjs/testing';
import { AiService } from './ai.service';
import { AiCacheService } from './cache/ai-cache.service';
import { QuotaService } from './quota/quota.service';
import { FallbackProvider } from './providers/fallback.provider';
import { OpenAiProvider } from './providers/openai.provider';
import { AI_PROVIDER, AI_FALLBACK_PROVIDER } from './ai.provider';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import axios from 'axios';

describe('AI Provider Integration', () => {
  let service: AiService;
  let openAiProvider: OpenAiProvider;
  let cacheService: AiCacheService;

  const mockConfig = {
    get: jest.fn((key: string) => {
      if (key === 'OPENAI_API_KEY') return 'test-key';
      if (key === 'AI_TIMEOUT_MS') return 5000;
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
        {
          provide: RedisService,
          useValue: {
            client: {
              get: jest.fn().mockResolvedValue(null),
              incr: jest.fn().mockResolvedValue(1),
              incrBy: jest.fn().mockResolvedValue(1),
              expire: jest.fn().mockResolvedValue(1),
            },
          },
        },
        { provide: ConfigService, useValue: mockConfig },
        { provide: AI_PROVIDER, useExisting: OpenAiProvider },
        { provide: AI_FALLBACK_PROVIDER, useClass: FallbackProvider },
      ],
    }).compile();

    service = module.get<AiService>(AiService);
    openAiProvider = module.get<OpenAiProvider>(OpenAiProvider);
    cacheService = module.get<AiCacheService>(AiCacheService);
  });

  afterEach(() => jest.restoreAllMocks());

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
      await expect(openAiProvider.generate('test')).rejects.toThrow();
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
});
