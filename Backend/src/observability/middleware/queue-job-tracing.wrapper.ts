import { Injectable } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { TracingService } from '../services/tracing.service';
import { LoggingService } from '../services/logging.service';
import { MetricsService } from '../services/metrics.service';
import { TraceContext } from '../types/trace-context.interface';

/**
 * Queue Job Tracing Wrapper
 * Propagates trace context through Bull queue jobs
 * Records metrics for job execution
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
    processor: (job: Job<T>) => Promise<any> | any,
    jobName: string,
  ): (job: Job<T>) => Promise<any> {
    return async (job: Job<T>): Promise<any> => {
      const traceContext = this.createJobTraceContext(job, jobName);
      const startTime = Date.now();

      try {
        // Record job start
        this.metricsService.recordJobStart(jobName);

        // Log job start
        this.loggingService.info('Job processing started', {
          traceId: traceContext.traceId,
          spanId: traceContext.spanId,
          jobId: job.id,
          jobName,
          jobData: this.sanitizeJobData(job.data),
        });

        // Execute the actual processor
        const result = await processor(job);

        const duration = (Date.now() - startTime) / 1000; // Convert to seconds

        // Record job completion
        this.metricsService.recordJobCompleted(jobName, duration);

        // Log job completion
        this.loggingService.info('Job processing completed', {
          traceId: traceContext.traceId,
          spanId: traceContext.spanId,
          jobId: job.id,
          jobName,
          duration,
          result: this.sanitizeJobData(result),
        });

        // Clean up
        this.jobTraceMap.delete(job.id.toString());

        return result;
      } catch (error) {
        const duration = (Date.now() - startTime) / 1000;

        // Record job failure
        const errorType = error?.name || 'UnknownError';
        this.metricsService.recordJobFailed(jobName, duration, errorType);

        // Log job failure
        this.loggingService.error(
          'Job processing failed',
          error,
          {
            traceId: traceContext.traceId,
            spanId: traceContext.spanId,
            jobId: job.id,
            jobName,
            duration,
            jobData: this.sanitizeJobData(job.data),
          },
        );

        // Clean up
        this.jobTraceMap.delete(job.id.toString());

        throw error;
      }
    };
  }

  /**
   * Create trace context for job
   */
  private createJobTraceContext(job: Job, jobName: string): TraceContext {
    // Try to extract trace context from job data
    let traceContext: TraceContext;

    if (
      job.data &&
      typeof job.data === 'object' &&
      'traceContext' in job.data &&
      job.data.traceContext
    ) {
      // Use existing trace context from job data
      traceContext = this.tracingService.createTraceContext(
        job.data.traceContext.traceId,
        job.data.traceContext.spanId,
        job.data.traceContext.userId,
      );
    } else {
      // Create new trace context for background job
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
   * Inject trace context into job data
   */
  injectTraceContext(data: any, parentTraceContext: TraceContext): any {
    return {
      ...data,
      traceContext: {
        traceId: parentTraceContext.traceId,
        spanId: parentTraceContext.spanId,
        userId: parentTraceContext.userId,
      },
    };
  }

  /**
   * Wrap queue initialization with metrics tracking
   */
  wrapQueueMetrics(queue: Queue, queueName: string) {
    // Track job added to queue
    queue.on('waiting', () => {
      queue.count().then((count) => {
        this.metricsService.updateJobQueueSize(queueName, count);
      });
    });

    // Track job completion
    queue.on('completed', () => {
      queue.count().then((count) => {
        this.metricsService.updateJobQueueSize(queueName, count);
      });
    });

    // Track job failure
    queue.on('failed', () => {
      queue.count().then((count) => {
        this.metricsService.updateJobQueueSize(queueName, count);
      });
    });

    // Initial size
    queue.count().then((count) => {
      this.metricsService.updateJobQueueSize(queueName, count);
    });
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
    const sensitiveFields = ['password', 'token', 'secret', 'apiKey', 'privateKey'];

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
