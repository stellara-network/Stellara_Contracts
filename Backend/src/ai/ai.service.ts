import { Injectable } from '@nestjs/common';
import { AiCacheService } from './cache/ai-cache.service';
import { QuotaService } from './quota/quota.service';
import { AiRequestDto } from './dto/ai-request.dto';


@Injectable()
export class AiService {

    constructor(
        private readonly quotaService: QuotaService,
        private readonly cache: AiCacheService,
        // private readonly provider: AiProviderService,
    ) {}
  async handlePrompt(dto: AiRequestDto) {
    await this.quotaService.assertQuota(dto.userId);

    const cacheKey = this.cache.buildKey(dto.prompt, 'gpt-4');

    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return { response: cached, cached: true };
    }

    try {
      const result = await this.provider.generate(dto.prompt);

      await this.cache.set(cacheKey, result.response);
      await this.quotaService.recordUsage(dto.userId, result.tokensUsed);

      return { response: result.response, cached: false };
    } catch (err) {
      return {
        response:
          'AI service is temporarily unavailable. Please try again later.',
        degraded: true,
      };
    }
  }
}
