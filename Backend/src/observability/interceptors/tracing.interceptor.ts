import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { Request, Response } from 'express';
import { TracingService } from '../services/tracing.service';
import { LoggingService } from '../services/logging.service';
import { MetricsService } from '../services/metrics.service';

/**
 * HTTP Tracing Interceptor
 * Extracts/creates trace IDs, measures request duration, and logs errors
 * Propagates trace context to downstream services
 */
@Injectable()
export class TracingInterceptor implements NestInterceptor {
  constructor(
    private tracingService: TracingService,
    private loggingService: LoggingService,
    private metricsService: MetricsService,
  ) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    // Extract or create trace context
    const traceContext = this.tracingService.extractTraceContext(
      request.headers as Record<string, string>,
    );

    // Attach trace context to request for downstream access
    (request as any).traceContext = traceContext;

    // Set response headers with trace ID
    const traceHeaders = this.tracingService.injectTraceContext(traceContext);
    Object.entries(traceHeaders).forEach(([key, value]) => {
      response.setHeader(key, value);
    });

    // Log request start
    const startTime = Date.now();
    const requestSize = this.getRequestSize(request);

    this.loggingService.info('HTTP request received', {
      traceId: traceContext.traceId,
      spanId: traceContext.spanId,
      method: request.method,
      path: request.path,
      url: request.url,
      ip: this.getClientIp(request),
      userAgent: request.get('user-agent'),
      userId: traceContext.userId,
    });

    return next.handle().pipe(
      tap((responseData) => {
        const duration = (Date.now() - startTime) / 1000; // Convert to seconds
        const responseSize = this.getResponseSize(responseData);

        // Record metrics
        const statusCode = response.statusCode;
        const route = this.getRouteLabel(request);

        this.metricsService.recordHttpRequest(
          request.method,
          route,
          statusCode,
          duration,
          requestSize,
          responseSize,
        );

        // Log request completion
        this.loggingService.info('HTTP request completed', {
          traceId: traceContext.traceId,
          spanId: traceContext.spanId,
          method: request.method,
          path: request.path,
          statusCode,
          duration,
          requestSize,
          responseSize,
          userId: traceContext.userId,
        });
      }),
      catchError((error) => {
        const duration = (Date.now() - startTime) / 1000;
        const route = this.getRouteLabel(request);

        // Record error metrics
        this.metricsService.recordHttpError(
          request.method,
          route,
          error.name || 'UnknownError',
        );

        // Log error
        this.loggingService.error(
          'HTTP request error',
          error,
          {
            traceId: traceContext.traceId,
            spanId: traceContext.spanId,
            method: request.method,
            path: request.path,
            statusCode: response.statusCode,
            duration,
            userId: traceContext.userId,
            errorMessage: error.message,
          },
        );

        throw error;
      }),
    );
  }

  /**
   * Get request size in bytes
   */
  private getRequestSize(request: Request): number {
    const contentLength = request.get('content-length');
    return contentLength ? parseInt(contentLength) : 0;
  }

  /**
   * Get response size in bytes (estimate)
   */
  private getResponseSize(data: any): number {
    if (!data) return 0;
    if (typeof data === 'string') return Buffer.byteLength(data);
    try {
      return Buffer.byteLength(JSON.stringify(data));
    } catch {
      return 0;
    }
  }

  /**
   * Get client IP address
   */
  private getClientIp(request: Request): string {
    return (
      (request.get('x-forwarded-for') as string)?.split(',')[0] ||
      request.ip ||
      'unknown'
    );
  }

  /**
   * Get route label (e.g., GET /api/users/:id)
   */
  private getRouteLabel(request: Request): string {
    const route = (request as any).route?.path || request.path;
    return `${request.method} ${route}`;
  }
}
