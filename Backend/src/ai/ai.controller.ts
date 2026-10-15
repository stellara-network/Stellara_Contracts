import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AiRequestDto } from './dto/ai-request.dto';
import { AiService } from './ai.service';
import { AiCacheService } from './cache/ai-cache.service';
import { QuotaService } from './quota/quota.service';

@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly cacheService: AiCacheService,
    private readonly quotaService: QuotaService,
  ) {}

  @Throttle({ default: { limit: 5, ttl: 10000 } })
  @Post('prompt')
  async prompt(@Body() dto: AiRequestDto) {
    return this.aiService.handlePrompt(dto);
  }

  @Post('cache/invalidate')
  async invalidateCache(
    @Body() body: { pattern?: string; prompt?: string; model?: string },
  ) {
    if (body.prompt) {
      const deleted = await this.cacheService.invalidatePrompt(
        body.prompt,
        body.model || 'gpt-4',
      );
      return { success: deleted, invalidated: deleted ? 1 : 0 };
    }
    if (body.pattern) {
      const count = await this.cacheService.invalidateByPattern(body.pattern);
      return { success: true, invalidated: count };
    }
    if (body.model) {
      const count = await this.cacheService.invalidateModel(body.model);
      return { success: true, invalidated: count };
    }
    await this.cacheService.clear();
    return { success: true, message: 'AI cache cleared' };
  }

  @Get('quota/usage/:userId')
  async getUsage(@Param('userId') userId: string) {
    return this.quotaService.getQuotaUsage(userId);
  }
}
