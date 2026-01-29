import { Module } from '@nestjs/common';
import { LoggingService } from './services/logging.service';
import { TracingService } from './services/tracing.service';
import { MetricsService } from './services/metrics.service';
import { TracingInterceptor } from './interceptors/tracing.interceptor';
import { WebSocketTracingAdapter } from './middleware/websocket-tracing.adapter';
import { QueueJobTracingWrapper } from './middleware/queue-job-tracing.wrapper';
import { MetricsController } from './controllers/metrics.controller';

/**
 * Observability Module
 * Provides comprehensive logging, tracing, and metrics for the application
 * 
 * Features:
 * - Structured logging with Winston
 * - Distributed tracing with trace ID propagation (Jaeger-compatible)
 * - Prometheus metrics collection
 * - Integration with HTTP, WebSocket, and queue workers
 */
@Module({
  controllers: [MetricsController],
  providers: [
    LoggingService,
    TracingService,
    MetricsService,
    TracingInterceptor,
    WebSocketTracingAdapter,
    QueueJobTracingWrapper,
  ],
  exports: [
    LoggingService,
    TracingService,
    MetricsService,
    TracingInterceptor,
    WebSocketTracingAdapter,
    QueueJobTracingWrapper,
  ],
})
export class ObservabilityModule {}
