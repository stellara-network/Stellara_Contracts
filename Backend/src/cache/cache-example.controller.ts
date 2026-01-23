import { Controller, Get, Param, Query, HttpStatus } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { CacheService, CacheMetrics } from '../cache/cache.service';
import { MarketApiService, MarketSnapshot, ExtendedMarketData } from '../cache/market-api.service';
import { NewsApiService, NewsArticle } from '../cache/news-api.service';

/**
 * Cache Example Controller
 * Demonstrates integration of caching layer with API endpoints
 */
@ApiTags('Cache & Market Intelligence')
@Controller('api/cache')
export class CacheExampleController {
  constructor(
    private readonly cacheService: CacheService,
    private readonly marketApiService: MarketApiService,
    private readonly newsApiService: NewsApiService,
  ) {}

  // Market Endpoints with Caching

  @Get('market/:assetId')
  @ApiOperation({
    summary: 'Get market snapshot with caching',
    description: 'Returns cached market snapshot if available, otherwise fetches and caches fresh data',
  })
  @ApiParam({ name: 'assetId', description: 'Asset ID (e.g., USD-STELLARA)' })
  @ApiResponse({
    status: 200,
    description: 'Market snapshot data',
    schema: {
      example: {
        assetId: 'USD-STELLARA',
        price: 105.5,
        volume24h: 1000000,
        marketCap: 1000000000,
        priceChange24h: -2.5,
        timestamp: new Date(),
      },
    },
  })
  async getMarketSnapshot(@Param('assetId') assetId: string): Promise<MarketSnapshot> {
    return this.marketApiService.getMarketSnapshot(assetId);
  }

  @Get('market/:assetId/extended')
  @ApiOperation({
    summary: 'Get extended market data with technical indicators',
    description: 'Returns cached extended market data including technical indicators',
  })
  @ApiParam({ name: 'assetId', description: 'Asset ID' })
  @ApiResponse({
    status: 200,
    description: 'Extended market data with technical indicators',
  })
  async getExtendedMarketData(@Param('assetId') assetId: string): Promise<ExtendedMarketData> {
    return this.marketApiService.getExtendedMarketData(assetId);
  }

  // News Endpoints with Caching

  @Get('news')
  @ApiOperation({
    summary: 'Get news articles with caching',
    description: 'Returns cached news articles if available, otherwise fetches fresh news',
  })
  @ApiQuery({
    name: 'category',
    required: false,
    description: 'News category (e.g., blockchain, defi, market-updates)',
  })
  @ApiResponse({
    status: 200,
    description: 'Array of news articles',
  })
  async getNews(@Query('category') category: string = 'all'): Promise<NewsArticle[]> {
    return this.newsApiService.getNews(category);
  }

  @Get('news/trending')
  @ApiOperation({
    summary: 'Get trending news with caching',
    description: 'Returns cached trending news articles',
  })
  @ApiResponse({
    status: 200,
    description: 'Array of trending news articles',
  })
  async getTrendingNews(): Promise<NewsArticle[]> {
    return this.newsApiService.getTrendingNews();
  }

  // Cache Management & Monitoring Endpoints

  @Get('metrics')
  @ApiOperation({
    summary: 'Get cache metrics',
    description: 'Returns cache hit/miss statistics and hit rates for all cache types',
  })
  @ApiResponse({
    status: 200,
    description: 'Cache metrics showing hits, misses, and hit rates',
    schema: {
      example: {
        'cache:market': {
          hits: 150,
          misses: 50,
          hitRate: 75,
          totalRequests: 200,
        },
        'cache:news': {
          hits: 100,
          misses: 25,
          hitRate: 80,
          totalRequests: 125,
        },
      },
    },
  })
  async getCacheMetrics(): Promise<Record<string, CacheMetrics>> {
    return this.cacheService.getMetrics();
  }

  @Get('info')
  @ApiOperation({
    summary: 'Get Redis and cache information',
    description: 'Returns Redis server info and cache configuration details',
  })
  @ApiResponse({
    status: 200,
    description: 'Redis information and cache configuration',
  })
  async getCacheInfo(): Promise<{
    redis: string;
    metrics: Record<string, CacheMetrics>;
    config: Record<string, { ttl: number; description: string }>;
  }> {
    const redis = await this.cacheService.getRedisInfo();
    const metrics = this.cacheService.getMetrics();

    return {
      redis,
      metrics,
      config: {
        market_snapshot: {
          ttl: 60,
          description: 'Market snapshot data (prices, volumes, etc.)',
        },
        market_snapshot_extended: {
          ttl: 300,
          description: 'Extended market data with technical indicators',
        },
        news: {
          ttl: 600,
          description: 'Crypto news and market updates',
        },
        news_trending: {
          ttl: 300,
          description: 'Trending news articles',
        },
      },
    };
  }
}
