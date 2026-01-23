import { Injectable, Logger } from '@nestjs/common';
import { NewsCacheService } from '../cache/news-cache.service';

/**
 * Example News API Service
 * Demonstrates how to integrate caching with external API calls for news
 */
@Injectable()
export class NewsApiService {
  private readonly logger = new Logger(NewsApiService.name);

  constructor(private readonly newsCache: NewsCacheService) {}

  /**
   * Get news articles with caching fallback
   */
  async getNews(category: string = 'all'): Promise<NewsArticle[]> {
    return this.newsCache.getNews(category, async () => {
      return this.fetchNewsFromApi(category);
    });
  }

  /**
   * Get trending news with caching
   */
  async getTrendingNews(): Promise<NewsArticle[]> {
    return this.newsCache.getTrendingNews(async () => {
      return this.fetchTrendingNewsFromApi();
    });
  }

  /**
   * Fetch news from third-party API
   * This would be replaced with actual API calls (e.g., CryptoNews, NewsAPI, etc.)
   */
  private async fetchNewsFromApi(category: string): Promise<NewsArticle[]> {
    // Simulate API call delay
    await new Promise((resolve) => setTimeout(resolve, 200));

    this.logger.log(`Fetching news for category: ${category} from API`);

    // Simulated API response
    const articles: NewsArticle[] = [
      {
        id: `${category}-1`,
        title: `${category.charAt(0).toUpperCase() + category.slice(1)} News 1`,
        description: 'Latest developments in the crypto space',
        source: 'CryptoNews',
        category,
        url: `https://example.com/news/${category}/1`,
        imageUrl: 'https://example.com/images/news-1.jpg',
        publishedAt: new Date(Date.now() - 3600000),
        sentiment: 'positive',
      },
      {
        id: `${category}-2`,
        title: `${category.charAt(0).toUpperCase() + category.slice(1)} News 2`,
        description: 'Market update on blockchain technology',
        source: 'CryptoNews',
        category,
        url: `https://example.com/news/${category}/2`,
        imageUrl: 'https://example.com/images/news-2.jpg',
        publishedAt: new Date(Date.now() - 7200000),
        sentiment: 'neutral',
      },
    ];

    return articles;
  }

  /**
   * Fetch trending news from API
   */
  private async fetchTrendingNewsFromApi(): Promise<NewsArticle[]> {
    // Simulate API call delay
    await new Promise((resolve) => setTimeout(resolve, 200));

    this.logger.log('Fetching trending news from API');

    const articles: NewsArticle[] = [
      {
        id: 'trending-1',
        title: 'Bitcoin Reaches New All-Time High',
        description: 'Cryptocurrency markets surge on positive regulatory news',
        source: 'CryptoNews',
        category: 'market-updates',
        url: 'https://example.com/news/trending/1',
        imageUrl: 'https://example.com/images/trending-1.jpg',
        publishedAt: new Date(),
        sentiment: 'positive',
      },
      {
        id: 'trending-2',
        title: 'Stellar Ecosystem Expands',
        description: 'New partnerships announced for Stellar blockchain',
        source: 'Stellar Official',
        category: 'stellar-updates',
        url: 'https://example.com/news/trending/2',
        imageUrl: 'https://example.com/images/trending-2.jpg',
        publishedAt: new Date(Date.now() - 1800000),
        sentiment: 'positive',
      },
    ];

    return articles;
  }
}

export interface NewsArticle {
  id: string;
  title: string;
  description: string;
  source: string;
  category: string;
  url: string;
  imageUrl?: string;
  publishedAt: Date;
  sentiment?: 'positive' | 'neutral' | 'negative';
}
