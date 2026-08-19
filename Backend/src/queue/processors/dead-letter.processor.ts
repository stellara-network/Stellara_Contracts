import { Processor, Process, OnQueueFailed } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';

/**
 * Processes jobs that have been routed to the `failed-jobs` DLQ after
 * exhausting all retry attempts.  Logs the failure and emits an alert event
 * that downstream consumers (e.g. an alerting service) can react to.
 */
@Processor('failed-jobs')
export class DeadLetterProcessor {
  private readonly logger = new Logger(DeadLetterProcessor.name);

  @Process()
  handleFailedJob(job: Job): void {
    this.logger.error(
      `DLQ job received — queue=${job.data?.originalQueue} id=${job.data?.originalJobId}`,
      JSON.stringify({
        originalQueue: job.data?.originalQueue,
        originalJobId: job.data?.originalJobId,
        failedReason: job.data?.failedReason,
        payload: job.data?.payload,
      }),
    );
    // Emit an alert event so downstream alerting services can react.
    job.queue.emit('dlq:alert', {
      queue: job.data?.originalQueue,
      jobId: job.data?.originalJobId,
      reason: job.data?.failedReason,
    });
  }

  @OnQueueFailed()
  onFailed(job: Job, err: Error): void {
    this.logger.error(
      `DLQ processor itself failed for job ${job.id}: ${err.message}`,
      err.stack,
    );
  }
}
