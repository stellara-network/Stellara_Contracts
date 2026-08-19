import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface DatabaseHealthCheckResult {
  status: 'ok' | 'error';
  message?: string;
  responseTimeMs?: number;
}

@Injectable()
export class DatabaseHealthIndicator {
  private readonly logger = new Logger(DatabaseHealthIndicator.name);

  constructor(private readonly dataSource: DataSource) {}

  async isHealthy(): Promise<DatabaseHealthCheckResult> {
    const start = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'ok', responseTimeMs: Date.now() - start };
    } catch (err: any) {
      this.logger.warn(`Database health check failed: ${err.message}`);
      return {
        status: 'error',
        message: err.message,
        responseTimeMs: Date.now() - start,
      };
    }
  }
}
