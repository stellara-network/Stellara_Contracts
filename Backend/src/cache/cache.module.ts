import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { CacheService } from './cache.service';
import { MarketCacheService } from './market-cache.service';
import { NewsCacheService } from './news-cache.service';
import { MarketApiService } from './market-api.service';
import { NewsApiService } from './news-api.service';
import { CacheInvalidationService } from './cache-invalidation.service';
import { CacheExampleController } from './cache-example.controller';

@Module({
  imports: [RedisModule],
  controllers: [CacheExampleController],
  providers: [
    CacheService,
    MarketCacheService,
    NewsCacheService,
    MarketApiService,
    NewsApiService,
    CacheInvalidationService,
  ],
  exports: [
    CacheService,
    MarketCacheService,
    NewsCacheService,
    MarketApiService,
    NewsApiService,
    CacheInvalidationService,
  ],
})
export class CacheModule {}
