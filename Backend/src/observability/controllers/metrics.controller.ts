import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { MetricsService } from '../services/metrics.service';

/**
 * Metrics Controller
 * Exposes Prometheus metrics endpoint for scraping
 */
@Controller('metrics')
export class MetricsController {
  constructor(private metricsService: MetricsService) {}

  /**
   * GET /metrics
   * Returns metrics in Prometheus format
   */
  @Get()
  async getMetrics(@Res() res: Response) {
    const metrics = await this.metricsService.getMetrics();
    res.set('Content-Type', this.metricsService.getMetricsContentType());
    res.send(metrics);
  }
}
