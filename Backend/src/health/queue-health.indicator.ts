import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';

export interface QueueHealthCheckResult {
  status: 'ok' | 'error' | 'degraded';
  message?: string;
  responseTimeMs?: number;
  queueCount?: number;
  failedCount?: number;
}

@Injectable()
export class QueueHealthIndicator {
  private readonly logger = new Logger(QueueHealthIndicator.name);

  constructor(
    @InjectQueue('deploy-contract')
    private readonly deployContractQueue: Queue,
    @InjectQueue('process-tts')
    private readonly processTtsQueue: Queue,
    @InjectQueue('index-market-news')
    private readonly indexMarketNewsQueue: Queue,
  ) {}

  async isHealthy(): Promise<QueueHealthCheckResult> {
    const start = Date.now();
    try {
      const queues = [
        this.deployContractQueue,
        this.processTtsQueue,
        this.indexMarketNewsQueue,
      ];

      let totalFailed = 0;

      for (const queue of queues) {
        const [, failed] = await Promise.all([
          queue.getWaitingCount(),
          queue.getFailedCount(),
        ]);
        totalFailed += failed;
      }

      const responseTimeMs = Date.now() - start;

      if (totalFailed > 100) {
        return {
          status: 'degraded',
          message: `${totalFailed} failed jobs across queues`,
          responseTimeMs,
          queueCount: queues.length,
          failedCount: totalFailed,
        };
      }

      return {
        status: 'ok',
        responseTimeMs,
        queueCount: queues.length,
        failedCount: totalFailed,
      };
    } catch (err: any) {
      this.logger.warn(`Queue health check failed: ${err.message}`);
      return {
        status: 'error',
        message: err.message,
        responseTimeMs: Date.now() - start,
      };
    }
  }
}
