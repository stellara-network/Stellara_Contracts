import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DatabaseHealthIndicator } from './database-health.indicator';
import { RedisHealthIndicator } from './redis-health.indicator';
import {
  QueueHealthIndicator,
  QueueHealthCheckResult,
} from './queue-health.indicator';
import { AuthHealthIndicator } from './auth-health.indicator';
import { StellarEventMonitorService } from '../stellar-monitor/services/stellar-event-monitor.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly databaseHealthIndicator: DatabaseHealthIndicator,
    private readonly redisHealthIndicator: RedisHealthIndicator,
    private readonly queueHealthIndicator: QueueHealthIndicator,
    private readonly authHealthIndicator: AuthHealthIndicator,
    private readonly stellarMonitorService: StellarEventMonitorService,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe — confirms the process is running' })
  @ApiResponse({ status: 200, description: 'Service is alive' })
  getLiveness() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe — checks all downstream dependencies',
  })
  @ApiResponse({ status: 200, description: 'All dependencies healthy' })
  @ApiResponse({
    status: 503,
    description: 'One or more dependencies unhealthy',
  })
  async getReadiness() {
    const start = Date.now();
    const checks: Record<string, any> = {};
    let allHealthy = true;

    // Database
    const databaseCheck = await this.databaseHealthIndicator.isHealthy();
    checks.database = databaseCheck;
    if (databaseCheck.status === 'error') {
      allHealthy = false;
    }

    // Redis
    const redisCheck = await this.redisHealthIndicator.isHealthy();
    checks.redis = redisCheck;
    if (redisCheck.status === 'error') {
      allHealthy = false;
    }

    // Queue
    const queueCheck: QueueHealthCheckResult =
      await this.queueHealthIndicator.isHealthy();
    checks.queue = queueCheck;
    if (queueCheck.status === 'error') {
      allHealthy = false;
    }

    // Auth
    const authCheck = this.authHealthIndicator.isHealthy();
    checks.auth = authCheck;
    if (authCheck.status === 'error') {
      allHealthy = false;
    }

    // Stellar Monitor (existing)
    try {
      const monitorStatus = this.stellarMonitorService.getStatus();
      checks.stellarMonitor = {
        status: monitorStatus.isMonitoring ? 'ok' : 'degraded',
        isMonitoring: monitorStatus.isMonitoring,
        lastLedgerSequence: monitorStatus.lastLedgerSequence,
        horizonUrl: monitorStatus.horizonUrl,
      };
    } catch (err: any) {
      this.logger.warn(`Stellar monitor health check failed: ${err.message}`);
      checks.stellarMonitor = { status: 'error', message: err.message };
    }

    const response = {
      status: allHealthy ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      responseTimeMs: Date.now() - start,
      checks,
    };

    if (!allHealthy) {
      throw new ServiceUnavailableException(response);
    }

    return response;
  }
}
