import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { SecretsMaskingService } from './secrets-masking.service';
import { createClient, RedisClientType } from 'redis';
import { buildRedisUrl } from '../redis/redis.config';

/**
 * Result of a single dependency check.
 */
export interface DependencyCheckResult {
  name: string;
  status: 'ok' | 'error' | 'skipped';
  message?: string;
  responseTimeMs: number;
  details?: Record<string, unknown>;
}

/**
 * Aggregate result of all startup dependency checks.
 */
export interface StartupValidationReport {
  success: boolean;
  checks: DependencyCheckResult[];
  totalTimeMs: number;
  timestamp: string;
}

/**
 * Default timeout (ms) for individual dependency connectivity checks.
 */
const DEFAULT_CHECK_TIMEOUT_MS = 5_000;

@Injectable()
export class StartupValidationService {
  private readonly logger = new Logger(StartupValidationService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly maskingService: SecretsMaskingService,
  ) {}

  /**
   * Run all startup dependency checks.
   * Returns a report with per-dependency status and an overall pass/fail.
   *
   * @param options.timeoutMs  Per-check timeout in milliseconds.
  * @param options.failOnError If true, throws when any dependency check fails.
   */
  async validate(options?: {
    timeoutMs?: number;
    failOnError?: boolean;
  }): Promise<StartupValidationReport> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    const failOnError = options?.failOnError ?? true;
    const startTime = Date.now();

    this.logger.log('Running startup dependency validation…');

    const checks: DependencyCheckResult[] = [];

    // Run checks in parallel for faster startup
    const [dbCheck, redisCheck, queueConfigCheck] = await Promise.allSettled([
      this.checkDatabase(timeoutMs),
      this.checkRedis(timeoutMs),
      Promise.resolve(this.checkQueueConfig()),
    ]);

    if (dbCheck.status === 'fulfilled') checks.push(dbCheck.value);
    else checks.push({
      name: 'database',
      status: 'error',
      message: `Database check threw: ${(dbCheck.reason as Error)?.message}`,
      responseTimeMs: 0,
    });

    if (redisCheck.status === 'fulfilled') checks.push(redisCheck.value);
    else checks.push({
      name: 'redis',
      status: 'error',
      message: `Redis check threw: ${(redisCheck.reason as Error)?.message}`,
      responseTimeMs: 0,
    });

    if (queueConfigCheck.status === 'fulfilled') checks.push(queueConfigCheck.value);
    else checks.push({
      name: 'queue-config',
      status: 'error',
      message: `Queue config check threw: ${(queueConfigCheck.reason as Error)?.message}`,
      responseTimeMs: 0,
    });

    const totalTimeMs = Date.now() - startTime;

    // Build report
    const report: StartupValidationReport = {
      success: checks.every((c) => c.status !== 'error'),
      checks,
      totalTimeMs,
      timestamp: new Date().toISOString(),
    };

    // Log summary
    this.logStartupReport(report);

    const failures = checks.filter((c) => c.status === 'error');
    if (failOnError && failures.length > 0) {
      const messages = failures.map((c) => `${c.name}: ${c.message}`).join('; ');
      throw new Error(
        `Startup validation failed — dependency unavailable: ${messages}`,
      );
    }

    if (failures.length > 0) {
      this.logger.warn(
        `Startup dependency validation found ${failures.length} failure(s); application is not ready`,
      );
    }

    return report;
  }

  /**
   * Validate database connectivity by running a simple query with a timeout.
   */
  private async checkDatabase(timeoutMs: number): Promise<DependencyCheckResult> {
    const start = Date.now();
    try {
      const queryPromise = this.dataSource.query('SELECT 1 AS ok');
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Database connection timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      );

      await Promise.race([queryPromise, timeoutPromise]);

      const responseTimeMs = Date.now() - start;
      return {
        name: 'database',
        status: 'ok',
        responseTimeMs,
        details: {
          host: this.configService.get('DB_HOST'),
          port: this.configService.get('DB_PORT') ?? 5432,
          database: this.configService.get('DB_DATABASE'),
        },
      };
    } catch (err) {
      const responseTimeMs = Date.now() - start;
      const safeMessage = this.maskingService.mask((err as Error).message);
      return {
        name: 'database',
        status: 'error',
        message: safeMessage,
        responseTimeMs,
      };
    }
  }

  /**
   * Validate Redis connectivity by creating a temporary client, pinging, and disconnecting.
   * Uses a timeout to avoid blocking startup if Redis is unreachable.
   */
  private async checkRedis(timeoutMs: number): Promise<DependencyCheckResult> {
    const start = Date.now();
    const url = buildRedisUrl({
      REDIS_URL: this.configService.get('REDIS_URL'),
      REDIS_HOST: this.configService.get('REDIS_HOST'),
      REDIS_PORT: this.configService.get('REDIS_PORT'),
      REDIS_PASSWORD: this.configService.get('REDIS_PASSWORD'),
    });

    let client: RedisClientType | undefined;
    try {
      client = createClient({
        url,
        socket: {
          connectTimeout: timeoutMs,
          // No retry — we want a fast fail at startup
          reconnectStrategy: false as any,
        },
      }) as RedisClientType;

      const connectPromise = client.connect();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Redis connection timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      );

      await Promise.race([connectPromise, timeoutPromise]);

      const pingPromise = client.ping();
      const pingTimeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Redis PING timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      );

      await Promise.race([pingPromise, pingTimeoutPromise]);

      const responseTimeMs = Date.now() - start;
      return {
        name: 'redis',
        status: 'ok',
        responseTimeMs,
        details: {
          url: this.maskingService.mask(url),
        },
      };
    } catch (err) {
      const responseTimeMs = Date.now() - start;
      const safeMessage = this.maskingService.mask((err as Error).message);
      return {
        name: 'redis',
        status: 'error',
        message: safeMessage,
        responseTimeMs,
      };
    } finally {
      try {
        await client?.quit().catch(() => {});
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Validate Bull queue configuration parameters without making a network call.
   * Checks that the required env vars are present and sensible.
   */
  private checkQueueConfig(): DependencyCheckResult {
    const start = Date.now();

    const hasRedisUrl = !!this.configService.get('REDIS_URL');
    const hasRedisHost = !!this.configService.get('REDIS_HOST');
    const redisHost = this.configService.get('REDIS_HOST') || 'localhost';
    const redisPort = this.configService.get('REDIS_PORT') || 6379;
    const redisQueueDb = parseInt(String(this.configService.get('REDIS_QUEUE_DB') ?? 1), 10);

    const warnings: string[] = [];

    // Bull requires either REDIS_URL or REDIS_HOST + REDIS_PORT
    if (!hasRedisUrl && !hasRedisHost) {
      return {
        name: 'queue-config',
        status: 'error',
        message: 'Queue requires REDIS_URL or REDIS_HOST to be configured',
        responseTimeMs: Date.now() - start,
      };
    }

    // Queue DB should be different from the main Redis DB
    if (!isNaN(redisQueueDb) && redisQueueDb === 0) {
      warnings.push(
        'REDIS_QUEUE_DB is 0 — consider using a separate DB for queues to avoid key collisions',
      );
    }

    const concurrencyVars = [
      {
        envKey: 'QUEUE_DEPLOY_CONTRACT_CONCURRENCY',
        default: 2,
      },
      {
        envKey: 'QUEUE_PROCESS_TTS_CONCURRENCY',
        default: 4,
      },
      {
        envKey: 'QUEUE_INDEX_MARKET_NEWS_CONCURRENCY',
        default: 3,
      },
    ];

    const queueNames = ['deploy-contract', 'process-tts', 'index-market-news'];
    const queueDetails: Record<string, unknown> = {};

    for (let i = 0; i < concurrencyVars.length; i++) {
      const { envKey, default: defaultVal } = concurrencyVars[i];
      const val = parseInt(String(this.configService.get(envKey) || defaultVal), 10);
      queueDetails[queueNames[i]] = {
        concurrency: val,
        envKey,
      };

      if (isNaN(val) || val < 1 || val > 50) {
        return {
          name: 'queue-config',
          status: 'error',
          message: `${envKey} must be between 1 and 50, got "${this.configService.get(envKey)}"`,
          responseTimeMs: Date.now() - start,
        };
      }
    }

    if (warnings.length > 0) {
      for (const w of warnings) {
        this.logger.warn(w);
      }
    }

    return {
      name: 'queue-config',
      status: 'ok',
      responseTimeMs: Date.now() - start,
      details: {
        redisHost,
        redisPort,
        queueDb: redisQueueDb,
        queues: queueDetails,
        defaultAttempts: this.configService.get('QUEUE_DEFAULT_ATTEMPTS') ?? 3,
        defaultBackoffDelay: this.configService.get('QUEUE_DEFAULT_BACKOFF_DELAY') ?? 2000,
      },
    };
  }

  /**
   * Log a structured startup validation report.
   */
  private logStartupReport(report: StartupValidationReport): void {
    const statusIcon = report.success ? '✅' : '❌';

    this.logger.log(
      `${statusIcon} Startup validation complete in ${report.totalTimeMs}ms — ` +
        `${report.checks.filter((c) => c.status === 'ok').length}/${report.checks.length} dependencies healthy`,
    );

    for (const check of report.checks) {
      const icon = check.status === 'ok' ? '✅' : check.status === 'skipped' ? '⏭️' : '❌';
      const detailStr = check.details
        ? ` (${JSON.stringify(check.details)})`
        : '';
      const msgStr = check.message ? ` — ${check.message}` : '';

      this.logger.log(
        `  ${icon} ${check.name}: ${check.status} (${check.responseTimeMs}ms)${msgStr}${detailStr}`,
      );
    }
  }
}
