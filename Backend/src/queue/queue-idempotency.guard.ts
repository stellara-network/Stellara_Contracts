import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import * as crypto from 'crypto';
import { IdempotencyResult } from './types/job.types';

@Injectable()
export class QueueIdempotencyGuard {
  private readonly logger = new Logger(QueueIdempotencyGuard.name);

  private readonly IDEMPOTENCY_PREFIX = 'queue:idempotency:';
  private readonly IDEMPOTENCY_TTL_SECONDS = 86400; // 24 hours

  constructor(private readonly redisService: RedisService) {}

  /**
   * Generate an idempotency key from job type + payload.
   *
   * The payload is canonicalized by recursively sorting object keys so the
   * key is stable regardless of key insertion order, and — critically — the
   * full payload is included (a naive array replacer drops nested fields).
   */
  generateIdempotencyKey(
    jobType: string,
    payload: Record<string, any>,
  ): string {
    const canonical = JSON.stringify(this.sortKeys({ jobType, payload }));
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  private sortKeys(value: any): any {
    if (Array.isArray(value)) {
      return value.map((item) => this.sortKeys(item));
    }
    if (value && typeof value === 'object') {
      return Object.keys(value)
        .sort()
        .reduce((acc: Record<string, any>, key: string) => {
          acc[key] = this.sortKeys(value[key]);
          return acc;
        }, {});
    }
    return value;
  }

  /**
   * Check for duplicate and atomically claim the idempotency slot.
   * Returns true if this is a NEW job (not a duplicate), false if duplicate.
   */
  async acquireIdempotencyKey(
    idempotencyKey: string,
    jobId: string | number,
  ): Promise<boolean> {
    const key = `${this.IDEMPOTENCY_PREFIX}${idempotencyKey}`;

    try {
      const result = await this.redisService.client.set(key, jobId.toString(), {
        NX: true,
        EX: this.IDEMPOTENCY_TTL_SECONDS,
      });

      if (result === null) {
        this.logger.warn(
          `Duplicate job detected for idempotency key: ${idempotencyKey}`,
        );
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error(
        `Failed to set idempotency key: ${error.message}`,
        error.stack,
      );
      // On Redis failure, allow the job through (fail-open)
      return true;
    }
  }

  /**
   * Check if an idempotency key already exists.
   */
  async isDuplicate(idempotencyKey: string): Promise<IdempotencyResult> {
    const key = `${this.IDEMPOTENCY_PREFIX}${idempotencyKey}`;

    try {
      const existingJobId = await this.redisService.client.get(key);
      if (existingJobId) {
        return { isDuplicate: true, jobId: existingJobId };
      }
      return { isDuplicate: false };
    } catch (error) {
      this.logger.error(`Failed to check idempotency key: ${error.message}`);
      return { isDuplicate: false };
    }
  }

  /**
   * Remove an idempotency key (e.g., on job cancellation).
   */
  async releaseIdempotencyKey(idempotencyKey: string): Promise<void> {
    const key = `${this.IDEMPOTENCY_PREFIX}${idempotencyKey}`;
    try {
      await this.redisService.client.del(key);
    } catch (error) {
      this.logger.error(`Failed to release idempotency key: ${error.message}`);
    }
  }
}
