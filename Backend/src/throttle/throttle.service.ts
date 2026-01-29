import { Injectable, TooManyRequestsException } from '@nestjs/common';
import { RATE_LIMITS, BAN_RULES } from './throttle.constants';
import { buildRateKey, buildBanKey } from './throttle.util';
import { RedisService } from 'src/redis/redis.service';

@Injectable()
export class ThrottleService {
  constructor(private readonly redis: RedisService) {}

  async checkRateLimit(key: string, limit: number, windowSeconds: number) {
    const current = await this.redis.client.incr(key);

    if (current === 1) {
      await this.redis.client.expire(key, windowSeconds);
    }

    const ttl = await this.redis.client.ttl(key);

    return { current, limit, ttl };
  }

  async checkBan(identifier: string) {
    const banned = await this.redis.client.get(buildBanKey(identifier));
    if (banned) {
      throw new TooManyRequestsException('Temporarily banned');
    }
  }

  async registerViolation(identifier: string) {
    const violationsKey = `violations:${identifier}`;
    const violations = await this.redis.client.incr(violationsKey);

    if (violations === 1) {
      await this.redis.client.expire(violationsKey, 3600);
    }

    if (violations >= BAN_RULES.MAX_VIOLATIONS) {
      const banSeconds =
        BAN_RULES.BASE_BAN_SECONDS * Math.pow(2, violations - 1);

      await this.redis.client.set(
        buildBanKey(identifier),
        '1',
        'EX',
        banSeconds,
      );
    }
  }
}
