import { Injectable } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { TracingService } from '../services/tracing.service';
import { LoggingService } from '../services/logging.service';
import { MetricsService } from '../services/metrics.service';
import { TraceContext } from '../types/trace-context.interface';

/**
 * Queue Job Tracing Wrapper
 * Propagates trace context + correlation ID through Bull queue jobs
 * and records metrics for job execution.
 */
@Injectable()
export class QueueJobTracingWrapper {
  private jobTraceMap = new Map<string, TraceContext>();

  constructor(
    private tracingService: TracingService,
    private loggingService: LoggingService,
    private metricsService: MetricsService,
  ) {}

  /**
   * Wrap job processor with tracing
   */
  wrapProcessor<T = any>(
    processor: (job: Job<T>) => any,
    jobName: string,
  ): (job: Job<T>) => Promise<any> {
    return async (job: Job<T>): Promise<any> => {
      const traceContext = this.createJobTraceContext(job, jobName);
      const correlationId =
        (traceContext.metadata?.['correlationId'] as string) ||
        this.metricsService.generateCorrelationId();
      const startTime = Date.now();

      try {
        this.metricsService.recordJobStart(jobName, correlationId);

        this.loggingService.info('Job processing started', {
          traceId: traceContext.traceId,
          spanId: traceContext.spanId,
          correlationId,
          jobId: job.id,
          jobName,
          jobData: this.sanitizeJobData(job.data),
        });

        const result = await processor(job);

        const duration = (Date.now() - startTime) / 1000;

        this.metricsService.recordJobCompleted(
          jobName,
          duration,
          correlationId,
        );

        this.loggingService.info('Job processing completed', {
          traceId: traceContext.traceId,
          spanId: traceContext.spanId,
          correlationId,
          jobId: job.id,
          jobName,
          duration,
          result: this.sanitizeJobData(result),
        });

        this.jobTraceMap.delete(job.id.toString());

        return result;
      } catch (error) {
        const duration = (Date.now() - startTime) / 1000;

        const errorType = error?.name || 'UnknownError';
        this.metricsService.recordJobFailed(
          jobName,
          duration,
          errorType,
          correlationId,
        );

        this.loggingService.error('Job processing failed', error, {
          traceId: traceContext.traceId,
          spanId: traceContext.spanId,
          correlationId,
          jobId: job.id,
          jobName,
          duration,
          jobData: this.sanitizeJobData(job.data),
        });

        this.jobTraceMap.delete(job.id.toString());

        throw error;
      }
    };
  }

  /**
   * Create trace context for job, preserving any existing correlation ID.
   */
  private createJobTraceContext(job: Job, jobName: string): TraceContext {
    let traceContext: TraceContext;

    if (
      job.data &&
      typeof job.data === 'object' &&
      'traceContext' in job.data &&
      job.data.traceContext
    ) {
      traceContext = this.tracingService.createTraceContext(
        job.data.traceContext.traceId,
        job.data.traceContext.spanId,
        job.data.traceContext.userId,
        { jobName, jobId: job.id, correlationId: job.data.correlationId },
      );
    } else {
      traceContext = this.tracingService.createTraceContext(
        undefined,
        undefined,
        undefined,
        { jobName, jobId: job.id },
      );
    }

    this.jobTraceMap.set(job.id.toString(), traceContext);
    return traceContext;
  }

  /**
   * Inject trace context into job data for cross-service propagation.
   */
  injectTraceContext(data: any, parentTraceContext: TraceContext): any {
    return {
      ...data,
      traceContext: {
        traceId: parentTraceContext.traceId,
        spanId: parentTraceContext.spanId,
        userId: parentTraceContext.userId,
      },
      correlationId:
        parentTraceContext.metadata?.['correlationId'] || undefined,
    };
  }

  /**
   * Wrap queue initialization with metrics tracking
   */
  wrapQueueMetrics(queue: Queue, queueName: string) {
    const updateSize = () => {
      void queue.count().then((count) => {
        this.metricsService.updateJobQueueSize(queueName, count);
      });
    };

    queue.on('waiting', updateSize);
    queue.on('completed', updateSize);
    queue.on('failed', updateSize);

    updateSize();
  }

  /**
   * Get trace context for job
   */
  getJobTraceContext(jobId: string): TraceContext | undefined {
    return this.jobTraceMap.get(jobId);
  }

  /**
   * Sanitize job data for logging (remove sensitive information)
   */
  private sanitizeJobData(data: any): any {
    if (!data) return undefined;

    if (typeof data !== 'object') {
      return data;
    }

    const sanitized = { ...data };
    const sensitiveFields = [
      'password',
      'token',
      'secret',
      'apiKey',
      'privateKey',
    ];

    for (const field of sensitiveFields) {
      if (field in sanitized) {
        sanitized[field] = '[REDACTED]';
      }
    }

    return sanitized;
  }

  /**
   * Get active job traces
   */
  getActiveJobTraces(): Map<string, TraceContext> {
    return new Map(this.jobTraceMap);
  }
}
