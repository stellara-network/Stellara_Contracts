import { Inject, Injectable, ForbiddenException } from '@nestjs/common';
import { AiCacheService } from './cache/ai-cache.service';
import { QuotaService } from './quota/quota.service';
import { AiRequestDto } from './dto/ai-request.dto';
import type { AiProvider } from './ai.provider';
import { AI_FALLBACK_PROVIDER } from './ai.provider';

export interface AiPromptResult {
  response: string;
  cached?: boolean;
  deduped?: boolean;
  tokensUsed?: number;
  degraded?: boolean;
}

@Injectable()
export class AiService {
  constructor(
    private readonly quotaService: QuotaService,
    private readonly cache: AiCacheService,
    @Inject(AI_FALLBACK_PROVIDER) private readonly provider: AiProvider,
  ) {}

  async handlePrompt(dto: AiRequestDto): Promise<AiPromptResult> {
    const model = dto.model || 'gpt-4';

    // 1. Quota & Budget Enforcement
    if (dto.userId) {
      await this.quotaService.assertQuota(dto.userId, dto.estimatedTokens);
    }

    const cacheKey = this.cache.buildKey(dto.prompt, model);

    // 2. Fast-path cache lookup
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return { response: cached, cached: true, deduped: false };
    }

    // 3. Deduplicated execution (in-flight coalescing)
    try {
      const { data: result, deduped } = await this.cache.deduplicate(
        cacheKey,
        async () => {
          // Double-check cache in case a concurrent request resolved just before
          const alreadyCached = await this.cache.get(cacheKey);
          if (alreadyCached) {
            return { response: alreadyCached, tokensUsed: 0, fromCache: true };
          }

          const gen = await this.provider.generate(dto.prompt);
          await this.cache.set(cacheKey, gen.response);
          return {
            response: gen.response,
            tokensUsed: gen.tokensUsed,
            fromCache: false,
          };
        },
      );

      // 4. Record usage only if freshly executed
      if (dto.userId && !result.fromCache && !deduped && result.tokensUsed) {
        await this.quotaService.recordUsage(dto.userId, result.tokensUsed);
      }

      return {
        response: result.response,
        cached: result.fromCache || false,
        deduped: deduped || false,
        tokensUsed: result.tokensUsed,
      };
    } catch (err: unknown) {
      if (err instanceof ForbiddenException) {
        throw err;
      }
      if (
        typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        (err as { status: unknown }).status === 403
      ) {
        throw err;
      }
      return {
        response:
          'AI service is temporarily unavailable. Please try again later.',
        degraded: true,
      };
    }
  }
}
