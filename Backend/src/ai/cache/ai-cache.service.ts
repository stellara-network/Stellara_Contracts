import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';

@Injectable()
export class AiCacheService {
  private readonly TTL = 3600;

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string) {
    await this.redis.set(key, value, 'EX', this.TTL);
  }

  buildKey(input: string, model: string) {
    return `ai:${model}:${createHash('sha256').update(input).digest('hex')}`;
  }
}
