import { Injectable, Logger } from '@nestjs/common';
import { MarketCacheService } from '../cache/market-cache.service';
import { NewsCacheService } from '../cache/news-cache.service';

/**
 * Example Market API Service
 * Demonstrates how to integrate caching with external API calls
 */
@Injectable()
export class MarketApiService {
  private readonly logger = new Logger(MarketApiService.name);

  constructor(private readonly marketCache: MarketCacheService) {}

  /**
   * Get market snapshot with caching fallback
   * Returns cached data if available, otherwise fetches fresh data
   */
  async getMarketSnapshot(assetId: string): Promise<MarketSnapshot> {
    return this.marketCache.getMarketSnapshot(assetId, async () => {
      return this.fetchMarketSnapshotFromApi(assetId);
    });
  }

  /**
   * Get extended market data with technical indicators and caching
   */
  async getExtendedMarketData(assetId: string): Promise<ExtendedMarketData> {
    return this.marketCache.getExtendedMarketData(assetId, async () => {
      return this.fetchExtendedMarketDataFromApi(assetId);
    });
  }

  /**
   * Fetch live market snapshot from third-party API
   * This would be replaced with actual API calls (e.g., CoinGecko, Binance, etc.)
   */
  private async fetchMarketSnapshotFromApi(assetId: string): Promise<MarketSnapshot> {
    // Simulate API call delay
    await new Promise((resolve) => setTimeout(resolve, 100));

    this.logger.log(`Fetching market snapshot for ${assetId} from API`);

    // Simulated API response
    return {
      assetId,
      price: 100.5 + Math.random() * 10,
      volume24h: 1000000 + Math.random() * 100000,
      marketCap: 1000000000 + Math.random() * 100000000,
      priceChange24h: -2.5 + Math.random() * 5,
      timestamp: new Date(),
    };
  }

  /**
   * Fetch extended market data from API
   */
  private async fetchExtendedMarketDataFromApi(
    assetId: string,
  ): Promise<ExtendedMarketData> {
    // Simulate API call delay
    await new Promise((resolve) => setTimeout(resolve, 150));

    this.logger.log(`Fetching extended market data for ${assetId} from API`);

    return {
      assetId,
      price: 100.5 + Math.random() * 10,
      volume24h: 1000000 + Math.random() * 100000,
      marketCap: 1000000000 + Math.random() * 100000000,
      priceChange24h: -2.5 + Math.random() * 5,
      rsi: 40 + Math.random() * 40, // RSI between 40-80
      macd: {
        value: Math.random() - 0.5,
        signal: Math.random() - 0.5,
        histogram: Math.random() - 0.5,
      },
      bollingerBands: {
        upper: 110 + Math.random() * 5,
        middle: 100 + Math.random() * 5,
        lower: 90 + Math.random() * 5,
      },
      movingAverages: {
        sma20: 100 + Math.random() * 5,
        sma50: 99 + Math.random() * 5,
        ema12: 101 + Math.random() * 5,
      },
      timestamp: new Date(),
    };
  }
}

export interface MarketSnapshot {
  assetId: string;
  price: number;
  volume24h: number;
  marketCap: number;
  priceChange24h: number;
  timestamp: Date;
}

export interface TechnicalIndicators {
  rsi: number;
  macd: { value: number; signal: number; histogram: number };
  bollingerBands: { upper: number; middle: number; lower: number };
  movingAverages: { sma20: number; sma50: number; ema12: number };
}

export interface ExtendedMarketData extends MarketSnapshot, TechnicalIndicators {}
