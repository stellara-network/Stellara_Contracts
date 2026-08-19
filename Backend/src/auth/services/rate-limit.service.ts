import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { Redis } from 'ioredis';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  // Refactored Lua script to return an array containing: [allowed_status, remaining_count, ttl_seconds]
  private readonly rateLimitLuaScript = `
    local key = KEYS[1]
    local limit = tonumber(ARGV[1])
    local window = tonumber(ARGV[2])

    local current = redis.call('get', key)
    if current and tonumber(current) >= limit then
        local ttl = redis.call('ttl', key)
        return {0, 0, ttl}
    else
        current = redis.call('incr', key)
        if tonumber(current) == 1 then
            redis.call('expire', key, window)
        end
        local ttl = redis.call('ttl', key)
        if ttl < 0 then ttl = window end
        return {1, limit - tonumber(current), ttl}
    end
  `;

  constructor(private readonly redisClient: Redis) {}

  /**
   * Helper utility to keep uniform key structuring strategies across guards
   */
  generateKeyForIp(ip: string, prefix: string): string {
    return `rate_limit:${prefix}:${ip}`;
  }

  /**
   * Evaluates an execution cadence atomically with strict fail-closed fallbacks.
   */
  async checkRateLimit(
    ip: string,
    route: string,
    limit = 5,
    windowInSeconds = 60,
  ): Promise<RateLimitResult> {
    const cacheKey = this.generateKeyForIp(ip, route);

    try {
      // Execute evaluation and parse array responses: [allowed, remaining, ttl]
      const [allowed, remaining, ttl] = (await this.redisClient.eval(
        this.rateLimitLuaScript,
        1,
        cacheKey,
        limit.toString(),
        windowInSeconds.toString(),
      )) as [number, number, number];

      return {
        allowed: allowed === 1,
        remaining: remaining,
        resetAt: new Date(
          Date.now() + (ttl > 0 ? ttl : windowInSeconds) * 1000,
        ),
      };
    } catch (redisError) {
      this.logger.error(
        `Redis operational failure on key [${cacheKey}]:`,
        redisError,
      );

      if (
        route.includes('/auth') ||
        route.includes('/login') ||
        route.includes('/register')
      ) {
        this.logger.warn(
          `Fail-Closed policy blocking traffic to sensitive target: ${route}`,
        );
        throw new InternalServerErrorException('Security validation failure.');
      }

      // Fail Open for non-sensitive public routes
      return {
        allowed: true,
        remaining: 1,
        resetAt: new Date(Date.now() + windowInSeconds * 1000),
      };
    }
  }
}
