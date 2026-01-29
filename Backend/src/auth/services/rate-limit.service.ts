import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

@Injectable()
export class RateLimitService {
  constructor(private readonly redisService: RedisService) {}

  async checkRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
    const redisKey = `rate_limit:${key}`;
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    try {
      const redis = this.redisService.client;

      // Remove old entries outside the window
      await redis.zRemRangeByScore(redisKey, 0, windowStart);

      // Count requests in current window
      const requestCount = await redis.zCard(redisKey);

      if (requestCount >= limit) {
        // Rate limit exceeded
        const oldestEntry = await redis.zRange(redisKey, 0, 0, { REV: false });
        const resetTime = oldestEntry.length > 0 
          ? parseInt(oldestEntry[0]) + windowSeconds * 1000 
          : now + windowSeconds * 1000;

        return {
          allowed: false,
          remaining: 0,
          resetAt: new Date(resetTime),
        };
      }

      // Add current request
      await redis.zAdd(redisKey, { score: now, value: `${now}` });

      // Set expiration on the key
      await redis.expire(redisKey, windowSeconds);

      return {
        allowed: true,
        remaining: limit - requestCount - 1,
        resetAt: new Date(now + windowSeconds * 1000),
      };
    } catch (error) {
      console.error('Rate limit check error:', error);
      // On Redis error, allow the request (fail open)
      return {
        allowed: true,
        remaining: limit,
        resetAt: new Date(now + windowSeconds * 1000),
      };
    }
  }

  async resetRateLimit(key: string): Promise<void> {
    const redisKey = `rate_limit:${key}`;
    try {
      const redis = this.redisService.client;
      await redis.del(redisKey);
    } catch (error) {
      console.error('Rate limit reset error:', error);
    }
  }

  generateKeyForIp(ip: string, endpoint: string): string {
    return `ip:${ip}:${endpoint}`;
  }

  generateKeyForUser(userId: string, endpoint: string): string {
    return `user:${userId}:${endpoint}`;
  }
}
