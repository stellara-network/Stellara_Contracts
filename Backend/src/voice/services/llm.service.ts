import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import * as crypto from 'crypto';

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  
  // Constants for quotas and rate limiting
  private readonly MONTHLY_QUOTA = 1000; // requests per month
  private readonly RPM_LIMIT = 20; // requests per minute
  private readonly CACHE_TTL = 3600 * 24; // 24 hours in seconds
  private readonly CACHE_VERSION = 'v1';
  private readonly FALLBACK_MESSAGE = "I'm sorry, I'm having trouble processing your request right now. Please try again in a moment.";

  constructor(private readonly redisService: RedisService) {}

  /**
   * Generates a response from the LLM with quota, rate limiting, and caching.
   */
  async generateResponse(userId: string, prompt: string, model: string = 'gpt-3.5-turbo'): Promise<{ content: string; cached: boolean }> {
    try {
      // 1. Enforce Safeguards
      await this.checkQuotasAndRateLimits(userId);

      // 2. Response Caching
      const cacheKey = this.generateCacheKey(prompt, model);
      const cachedResponse = await this.redisService.client.get(cacheKey);
      
      if (cachedResponse) {
        this.logger.log(`Cache hit for prompt hash: ${cacheKey.split(':').pop()}`);
        return { content: cachedResponse, cached: true };
      }

      // 3. Call LLM (Mocked for now, but wrapped in fallback logic)
      const response = await this.callLlmWithFallback(prompt);

      // 4. Store in Cache
      await this.redisService.client.set(cacheKey, response, {
        EX: this.CACHE_TTL
      });

      return { content: response, cached: false };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(`Unexpected error in LLM pipeline: ${error.message}`, error.stack);
      return { content: this.FALLBACK_MESSAGE, cached: false };
    }
  }

  /**
   * Checks monthly quotas and per-minute rate limits.
   */
  private async checkQuotasAndRateLimits(userId: string): Promise<void> {
    const now = new Date();
    const monthKey = `quota:${userId}:${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`;
    const rpmKey = `ratelimit:${userId}:${Math.floor(now.getTime() / 60000)}`;

    // Atomic increment for monthly quota
    const monthlyCount = await this.redisService.client.incr(monthKey);
    if (monthlyCount === 1) {
      // Set TTL to end of month
      const nextMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
      const ttlSeconds = Math.floor((nextMonth.getTime() - now.getTime()) / 1000);
      await this.redisService.client.expire(monthKey, ttlSeconds);
    }

    if (monthlyCount > this.MONTHLY_QUOTA) {
      this.logger.warn(`User ${userId} exceeded monthly quota: ${monthlyCount}/${this.MONTHLY_QUOTA}`);
      throw new HttpException(
        'Monthly usage quota exceeded. Please contact support.',
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    // Atomic increment for RPM (Fixed window strategy)
    const rpmCount = await this.redisService.client.incr(rpmKey);
    if (rpmCount === 1) {
      await this.redisService.client.expire(rpmKey, 60);
    }

    if (rpmCount > this.RPM_LIMIT) {
      this.logger.warn(`User ${userId} exceeded rate limit: ${rpmCount}/${this.RPM_LIMIT} RPM`);
      throw new HttpException(
        'Too many requests. Please slow down.',
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
  }

  /**
   * Generates a deterministic cache key.
   */
  private generateCacheKey(prompt: string, model: string): string {
    const normalizedPrompt = prompt.trim().toLowerCase();
    const hash = crypto.createHash('sha256').update(normalizedPrompt).digest('hex');
    return `llm:cache:${this.CACHE_VERSION}:${model}:${hash}`;
  }

  /**
   * Mocks LLM call with error handling and fallback.
   */
  private async callLlmWithFallback(prompt: string): Promise<string> {
    try {
      // Simulate potential failure
      if (prompt.toLowerCase().includes('force-fail')) {
        throw new Error('Simulated provider failure');
      }

      // Simulate network latency
      await new Promise(resolve => setTimeout(resolve, 500));

      // Mock responses
      const responses = [
        "I understand your question about " + prompt + ". Let me help you with that.",
        "That's an interesting point. Based on what you've said, I think the best approach would be to consider multiple factors.",
        "I can definitely help you with that. Here's what I recommend based on your situation.",
        "Thanks for sharing that with me. Let me provide you with some guidance on this topic.",
      ];

      return responses[Math.floor(Math.random() * responses.length)];
    } catch (error) {
      this.logger.error(`LLM Provider Error: ${error.message}`);
      return this.FALLBACK_MESSAGE;
    }
  }
}
