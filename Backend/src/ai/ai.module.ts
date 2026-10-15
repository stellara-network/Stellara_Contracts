import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { OpenAiProvider } from './providers/openai.provider';
import { FallbackProvider } from './providers/fallback.provider';
import { AiCacheService } from './cache/ai-cache.service';
import { QuotaService } from './quota/quota.service';
import { AI_PROVIDER, AI_FALLBACK_PROVIDER } from './ai.provider';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [ConfigModule, RedisModule],
  controllers: [AiController],
  providers: [
    AiService,
    AiCacheService,
    QuotaService,
    OpenAiProvider,
    { provide: AI_PROVIDER, useExisting: OpenAiProvider },
    FallbackProvider,
    { provide: AI_FALLBACK_PROVIDER, useExisting: FallbackProvider },
    { provide: 'REDIS_CLIENT', useValue: null },
  ],
  exports: [AiService, AiCacheService, QuotaService],
})
export class AiModule {}
