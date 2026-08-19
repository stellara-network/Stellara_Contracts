import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AiProvider } from '../ai.provider';
import { AI_PROVIDER } from '../ai.provider';
import { AiCacheService } from '../cache/ai-cache.service';

@Injectable()
export class FallbackProvider implements AiProvider {
  private readonly logger = new Logger(FallbackProvider.name);

  constructor(
    @Inject(AI_PROVIDER) private readonly primary: AiProvider,
    private readonly cache: AiCacheService,
  ) {}

  async generate(
    prompt: string,
  ): Promise<{ response: string; tokensUsed: number }> {
    // 1. Try primary provider
    try {
      return await this.primary.generate(prompt);
    } catch (primaryErr) {
      this.logger.warn(
        `Primary provider failed: ${(primaryErr as Error).message}`,
      );
    }

    // 2. Try cache as secondary
    const cacheKey = this.cache.buildKey(prompt, 'fallback');
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      this.logger.warn('Serving stale cache as fallback');
      return { response: cached, tokensUsed: 0 };
    }

    // 3. Final static fallback
    this.logger.error('All providers failed; returning degraded response');
    return {
      response:
        'AI service is temporarily unavailable. Please try again later.',
      tokensUsed: 0,
    };
  }
}
