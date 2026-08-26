import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';
import { SecretsMaskingService } from '../config/secrets-masking.service';
import { SecretsRotationService } from '../config/secrets-rotation.service';
import { buildRedisUrl } from './redis.config';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  public client!: RedisClientType;
  public pubClient!: RedisClientType;
  public subClient!: RedisClientType;

  constructor(
    private readonly maskingService: SecretsMaskingService,
    private readonly rotationService: SecretsRotationService,
  ) {}

  async onModuleInit() {
    await this.connect();

    // Register rotation hook: if REDIS_URL or REDIS_PASSWORD changes at
    // runtime, gracefully reconnect all three clients with the new credential.
    this.rotationService.onRotation('REDIS_URL', async (evt) => {
      this.logger.log(`REDIS_URL rotated (${evt.reason ?? 'manual'}); reconnecting Redis clients…`);
      await this.reconnect();
    });

    this.rotationService.onRotation('REDIS_PASSWORD', async (evt) => {
      this.logger.log(`REDIS_PASSWORD rotated (${evt.reason ?? 'manual'}); reconnecting Redis clients…`);
      await this.reconnect();
    });
  }

  async onModuleDestroy() {
    await this.quit();
  }

  /**
   * Establish connections for all three Redis client instances.
   * Logs only a masked version of the Redis URL so credentials never appear
   * in application logs.
   */
  private async connect(): Promise<void> {
    const url = buildRedisUrl();
    const safeUrl = this.maskingService.mask(url);

    this.logger.log(`Connecting to Redis: ${safeUrl}`);

    this.client = createClient({ url }) as RedisClientType;
    this.pubClient = createClient({ url }) as RedisClientType;
    this.subClient = createClient({ url }) as RedisClientType;

    // Attach error listeners that always log masked messages
    this.client.on('error', (err: Error) => {
      this.logger.error(`Redis client error: ${this.maskingService.mask(err.message)}`);
    });
    this.pubClient.on('error', (err: Error) => {
      this.logger.error(`Redis pubClient error: ${this.maskingService.mask(err.message)}`);
    });
    this.subClient.on('error', (err: Error) => {
      this.logger.error(`Redis subClient error: ${this.maskingService.mask(err.message)}`);
    });

    try {
      await Promise.all([
        this.client.connect(),
        this.pubClient.connect(),
        this.subClient.connect(),
      ]);
      this.logger.log('Redis connections established');
    } catch (err) {
      const safeMessage = this.maskingService.mask((err as Error).message);
      this.logger.error(`Failed to connect to Redis: ${safeMessage}`);
      throw new Error(`Redis connection failed: ${safeMessage}`);
    }
  }

  /**
   * Gracefully close then re-open all connections.
   * Used by the rotation hook when the Redis URL or password changes.
   */
  private async reconnect(): Promise<void> {
    try {
      await this.quit();
    } catch {
      // Ignore errors on closing stale connections
    }
    await this.connect();
    this.logger.log('Redis clients reconnected after secret rotation');
  }

  /**
   * Quit all three client connections.
   */
  private async quit(): Promise<void> {
    await Promise.all([
      this.client?.quit().catch(() => {}),
      this.pubClient?.quit().catch(() => {}),
      this.subClient?.quit().catch(() => {}),
    ]);
  }

  /**
   * Cursor-based key scan — safe to use in production (does not block Redis).
   * Returns all keys matching the given glob pattern.
   */
  async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';

    do {
      const reply = await this.client.scan(cursor, {
        MATCH: pattern,
        COUNT: 100,
      });
      cursor = reply.cursor;
      keys.push(...reply.keys);
    } while (cursor !== '0');

    return keys;
  }

  /**
   * Refresh the TTL of an existing key without changing its value.
   * Returns true if the key exists and the TTL was updated.
   */
  async refreshTTL(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.expire(key, ttlSeconds);
    return result === 1;
  }

  /**
   * Execute a Lua script atomically on the Redis server.
   * Lua scripts run as a single, uninterruptible command — ideal for
   * read-modify-write sequences that must not race.
   */
  async evalScript<T = unknown>(
    script: string,
    keys: string[],
    args: (string | number)[] = [],
  ): Promise<T> {
    return this.client.eval(script, {
      keys,
      arguments: args.map(String),
    }) as Promise<T>;
  }

  /**
   * Scan and delete keys matching a glob pattern that were last written
   * more than `olderThanMs` milliseconds ago (based on IDLETIME from
   * OBJECT IDLETIME, falling back to TTL-based heuristic).
   *
   * This is used to purge orphaned socket-tracking keys whose owning
   * connection is gone but whose TTL was inadvertently refreshed.
   */
  async purgeStaleKeys(
    pattern: string,
    olderThanSeconds: number,
  ): Promise<string[]> {
    const keys = await this.scanKeys(pattern);
    if (keys.length === 0) return [];

    const now = Date.now();
    const stale: string[] = [];

    // Use pipeline for batch TTL checks
    const pipeline = this.client.multi();
    for (const k of keys) {
      pipeline.ttl(k);
    }
    const ttlResults = (await pipeline.exec()) as unknown as (number | null)[];

    for (let i = 0; i < keys.length; i++) {
      const ttl = ttlResults[i];
      // ttl === -1 means key exists but has no expiry — treat as stale
      // ttl === -2 means key already gone — skip
      // ttl >= 0 && ttl <= threshold — key is about to expire or has
      //   been idle long enough
      if (ttl !== null && (ttl === -1 || ttl <= olderThanSeconds)) {
        stale.push(keys[i]);
      }
    }

    if (stale.length > 0) {
      const delPipeline = this.client.multi();
      for (const k of stale) {
        delPipeline.del(k);
      }
      await delPipeline.exec();
      this.logger.debug(`Purged ${stale.length} stale keys matching ${pattern}`);
    }

    return stale;
  }
}
