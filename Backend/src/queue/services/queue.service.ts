import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue, Job } from 'bull';
import { JobData, JobResult, JobStatus, JobInfo, RetryState } from '../types/job.types';
import { QueueMetrics, DlqEntry } from '../types/queue.types';
import { RedisService } from '../../redis/redis.service';
import { QueueJobTracingWrapper } from '../../observability/middleware/queue-job-tracing.wrapper';
import { TraceContext } from '../../observability/types/trace-context.interface';
import { QueueIdempotencyGuard } from '../queue-idempotency.guard';
import { QueueJobError } from '../types/errors';

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  // DLQ key prefix in Redis
  private readonly DLQ_PREFIX = 'queue:dlq:';
  private readonly RETRY_STATE_PREFIX = 'queue:retry:';

  // In-memory metrics counters (reset on process restart)
  private readonly metrics = {
    deduplicatedCount: 0,
    retryAttempts: 0,
    retryExhaustedCount: 0,
    byQueue: new Map<
      string,
      { submitted: number; deduplicated: number; retried: number; failed: number }
    >(),
  };

  private getQueueMetrics(queueName: string) {
    if (!this.metrics.byQueue.has(queueName)) {
      this.metrics.byQueue.set(queueName, {
        submitted: 0,
        deduplicated: 0,
        retried: 0,
        failed: 0,
      });
    }
    return this.metrics.byQueue.get(queueName)!;
  }

  constructor(
    @InjectQueue('deploy-contract') private deployContractQueue: Queue,
    @InjectQueue('process-tts') private processTtsQueue: Queue,
    @InjectQueue('index-market-news') private indexMarketNewsQueue: Queue,
    private readonly redisService: RedisService,
    private readonly queueJobTracingWrapper: QueueJobTracingWrapper,
    private readonly idempotencyGuard: QueueIdempotencyGuard,
  ) {
    this.initializeQueues();
  }

  private initializeQueues() {
    // Setup event listeners for all queues
    [
      this.deployContractQueue,
      this.processTtsQueue,
      this.indexMarketNewsQueue,
    ].forEach((queue) => {
      queue.on('failed', async (job: Job, error: Error) => {
        await this.handleJobFailure(job, error);
      });

      queue.on('completed', async (job: Job) => {
        this.logger.log(`Job ${job.id} completed: ${job.name}`);
      });

      queue.on('error', (error: Error) => {
        this.logger.error(`Queue error: ${error.message}`, error.stack);
      });
    });
  }

  private getQueueByName(queueName: string): Queue {
    switch (queueName) {
      case 'deploy-contract':
        return this.deployContractQueue;
      case 'process-tts':
        return this.processTtsQueue;
      case 'index-market-news':
        return this.indexMarketNewsQueue;
      default:
        throw new Error(`Unknown queue: ${queueName}`);
    }
  }

  /**
   * Add a job to the queue with idempotency checking.
   * Returns null if the job is a duplicate (already queued or completed).
   */
  async addJob<T extends JobData>(
    queueName: string,
    jobName: string,
    data: T,
    options: any = {},
    parentTraceContext?: TraceContext,
  ): Promise<Job<T> | null> {
    const queue = this.getQueueByName(queueName);

    // Check idempotency unless explicitly bypassed
    if (!options.skipIdempotencyCheck) {
      const idempotencyKey = this.idempotencyGuard.generateIdempotencyKey(
        `${queueName}:${jobName}`,
        data as Record<string, any>,
      );

      const isDuplicate =
        await this.idempotencyGuard.isDuplicate(idempotencyKey);
      if (isDuplicate.isDuplicate) {
        this.metrics.deduplicatedCount++;
        this.getQueueMetrics(queueName).deduplicated++;
        this.logger.warn(
          `Duplicate job rejected: ${jobName} on ${queueName} (existing job: ${isDuplicate.jobId})`,
        );
        return null;
      }
    }

    // Inject trace context if parentTraceContext is provided
    let jobData = data;
    if (parentTraceContext) {
      jobData = this.queueJobTracingWrapper.injectTraceContext(
        data,
        parentTraceContext,
      );
    }

    const job = await queue.add(jobName, jobData, {
      removeOnComplete: false, // Keep completed jobs for tracking
      removeOnFail: false, // Keep failed jobs for analysis
      ...options,
    });

    // Atomically claim the idempotency slot after successful add
    if (!options.skipIdempotencyCheck) {
      const idempotencyKey = this.idempotencyGuard.generateIdempotencyKey(
        `${queueName}:${jobName}`,
        data as Record<string, any>,
      );
      await this.idempotencyGuard.acquireIdempotencyKey(idempotencyKey, job.id);
    }

    // Resolve backoff parameters from options or defaults
    const backoffType = options.backoff?.type ?? 'exponential';
    const backoffDelay = options.backoff?.delay ?? 2000;
    const idempotencyKey = this.idempotencyGuard.generateIdempotencyKey(
      `${queueName}:${jobName}`,
      data as Record<string, any>,
    );

    // Initialize retry state with backoff parameters
    await this.saveRetryState({
      jobId: job.id.toString(),
      queueName,
      jobName,
      attemptCount: 0,
      maxAttempts: options.attempts || 3,
      firstAttemptedAt: new Date().toISOString(),
      lastAttemptedAt: new Date().toISOString(),
      idempotencyKey,
      backoffType,
      backoffDelay,
    });

    this.getQueueMetrics(queueName).submitted++;
    this.logger.log(`Job added: ${jobName} with ID: ${job.id}`);
    return job;
  }

  /**
   * Get job status and info, including retry state.
   */
  async getJobInfo(
    queueName: string,
    jobId: string | number,
  ): Promise<JobInfo | null> {
    const queue = this.getQueueByName(queueName);
    const job = await queue.getJob(jobId);

    if (!job) {
      return null;
    }

    const state = await job.getState();
    const progress = job.progress();
    const retryState =
      (await this.getRetryState(job.id.toString())) || undefined;

    return {
      id: job.id.toString(),
      name: job.name,
      status: this.mapJobState(state),
      progress: typeof progress === 'number' ? progress : 0,
      attempts: job.attemptsMade,
      maxAttempts: job.opts.attempts || 1,
      data: job.data,
      result: job.returnvalue
        ? { success: true, data: job.returnvalue }
        : undefined,
      error: job.failedReason || undefined,
      createdAt: new Date(job.timestamp),
      processedAt: job.processedOn ? new Date(job.processedOn) : undefined,
      completedAt: job.finishedOn ? new Date(job.finishedOn) : undefined,
      retryState,
    };
  }

  /**
   * Get all jobs with optional filtering by status
   */
  async getQueueJobs(
    queueName: string,
    statuses: string[] = ['active', 'completed', 'failed', 'delayed'],
  ): Promise<JobInfo[]> {
    const queue = this.getQueueByName(queueName);
    const jobs: Job[] = [];

    for (const status of statuses) {
      const statusJobs = await queue.getJobs(status as any);
      jobs.push(...statusJobs);
    }

    return Promise.all(
      jobs.map(async (job) => {
        const state = await job.getState();
        const progress = job.progress();

        return {
          id: job.id.toString(),
          name: job.name,
          status: this.mapJobState(state),
          progress: typeof progress === 'number' ? progress : 0,
          attempts: job.attemptsMade,
          maxAttempts: job.opts.attempts || 1,
          data: job.data,
          result: job.returnvalue
            ? { success: true, data: job.returnvalue }
            : undefined,
          error: job.failedReason || undefined,
          createdAt: new Date(job.timestamp),
          processedAt: job.processedOn ? new Date(job.processedOn) : undefined,
          completedAt: job.finishedOn ? new Date(job.finishedOn) : undefined,
        };
      }),
    );
  }

  /**
   * Get dead-letter queue (permanently failed jobs)
   */
  async getDeadLetterQueue(
    queueName: string,
    limit: number = 50,
  ): Promise<any[]> {
    const dlqKey = `${this.DLQ_PREFIX}${queueName}`;
    const dlqData = await this.redisService.client.lRange(dlqKey, 0, limit - 1);
    return dlqData.map((item) => {
      try {
        return JSON.parse(item);
      } catch {
        return item;
      }
    });
  }

  /**
   * Requeue a job that previously failed
   */
  async requeueJob(
    queueName: string,
    jobId: string | number,
  ): Promise<Job | null> {
    const queue = this.getQueueByName(queueName);
    const job = await queue.getJob(jobId);

    if (!job) {
      throw new Error(`Job ${jobId} not found in queue ${queueName}`);
    }

    // Create a new job with same data
    const newJob = await queue.add(job.name, job.data, {
      removeOnComplete: false,
      removeOnFail: false,
      attempts: job.opts.attempts || 3,
      backoff: job.opts.backoff,
    });

    this.logger.log(
      `Job requeued: ${job.name} (original ID: ${jobId}, new ID: ${newJob.id})`,
    );
    return newJob;
  }

  /**
   * Requeue multiple failed jobs from DLQ
   */
  async requeueFromDLQ(queueName: string, limit: number = 10): Promise<Job[]> {
    const dlqKey = `${this.DLQ_PREFIX}${queueName}`;
    const dlqData = await this.redisService.client.lRange(dlqKey, 0, limit - 1);
    const requeuedJobs: Job[] = [];

    for (const item of dlqData) {
      try {
        const jobData = JSON.parse(item);
        const queue = this.getQueueByName(queueName);
        const newJob = await queue.add(jobData.name, jobData.data, {
          removeOnComplete: false,
          removeOnFail: false,
          attempts: jobData.maxAttempts || 3,
        });
        requeuedJobs.push(newJob);
      } catch (error) {
        this.logger.error(`Failed to requeue DLQ item: ${error.message}`);
      }
    }

    // Remove requeued items from DLQ
    if (requeuedJobs.length > 0) {
      await this.redisService.client.lTrim(dlqKey, requeuedJobs.length, -1);
    }

    return requeuedJobs;
  }

  /**
   * Purge jobs from a queue
   */
  async purgeQueue(queueName: string): Promise<number> {
    const queue = this.getQueueByName(queueName);
    const jobs = await queue.clean(0, 'failed');
    const count = jobs.length;
    this.logger.log(`Purged ${count} jobs from queue ${queueName}`);
    return count;
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(queueName: string): Promise<{
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    waiting: number;
  }> {
    const queue = this.getQueueByName(queueName);
    const counts = await queue.getJobCounts();

    return {
      active: counts.active || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      delayed: counts.delayed || 0,
      waiting: counts.waiting || 0,
    };
  }

  /**
   * Update job progress
   */
  async updateJobProgress(
    queueName: string,
    jobId: string | number,
    progress: number,
  ): Promise<void> {
    const queue = this.getQueueByName(queueName);
    const job = await queue.getJob(jobId);

    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    await job.progress(progress);
  }

  /**
   * Save or update retry state for a job in Redis.
   */
  async saveRetryState(state: RetryState): Promise<void> {
    const key = `${this.RETRY_STATE_PREFIX}${state.jobId}`;
    try {
      await this.redisService.client.set(key, JSON.stringify(state), {
        EX: 86400, // 24h TTL
      });
    } catch (error) {
      this.logger.error(
        `Failed to save retry state for job ${state.jobId}: ${error.message}`,
      );
    }
  }

  /**
   * Get retry state for a job.
   */
  async getRetryState(jobId: string): Promise<RetryState | null> {
    const key = `${this.RETRY_STATE_PREFIX}${jobId}`;
    try {
      const data = await this.redisService.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      this.logger.error(
        `Failed to get retry state for job ${jobId}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Handle job failure - update retry state and move to DLQ if max retries exceeded.
   */
  private async handleJobFailure(job: Job, error: Error): Promise<void> {
    const maxAttempts = job.opts.attempts || 1;
    const attempts = job.attemptsMade;
    const queueName = job.queue.name;

    this.logger.error(
      `Job ${job.id} (${job.name}) failed: ${error.message} (attempt ${attempts}/${maxAttempts})`,
    );

    // Track retry attempt metrics
    this.getQueueMetrics(queueName).retried++;
    this.metrics.retryAttempts++;

    // Update retry state
    const retryState = await this.getRetryState(job.id.toString());
    if (retryState) {
      retryState.attemptCount = attempts;
      retryState.lastError = error.message;
      retryState.lastErrorStack = error.stack;
      retryState.lastErrorType = error.constructor?.name;
      retryState.lastRetryable = (error as QueueJobError).retryable ?? true;
      retryState.lastAttemptedAt = new Date().toISOString();
      retryState.maxAttempts = maxAttempts;

      // Calculate next retry time if retries remain
      if (attempts < maxAttempts) {
        const delay = this.calculateBackoffDelay(
          retryState.backoffType,
          retryState.backoffDelay,
          attempts,
        );
        retryState.nextRetryAt = new Date(Date.now() + delay).toISOString();
      }

      await this.saveRetryState(retryState);
    }

    // If max retries exceeded, move to DLQ with structured metadata
    if (attempts >= maxAttempts) {
      this.metrics.retryExhaustedCount++;
      this.getQueueMetrics(queueName).failed++;

      const dlqKey = `${this.DLQ_PREFIX}${queueName}`;
      const dlqEntry: DlqEntry = {
        id: job.id,
        name: job.name,
        queueName,
        data: job.data,
        errorMessage: error.message,
        errorStack: error.stack?.slice(0, 4096),
        errorType: error.constructor?.name,
        retryable: (error as QueueJobError).retryable ?? true,
        attempts,
        maxAttempts,
        failedAt: new Date().toISOString(),
        idempotencyKey: retryState?.idempotencyKey,
        retryState: retryState || undefined,
      };

      try {
        await this.redisService.client.rPush(dlqKey, JSON.stringify(dlqEntry));
        this.logger.warn(
          `Job ${job.id} (${job.name}) moved to DLQ after ${attempts} attempts`,
        );
      } catch (dlqError) {
        this.logger.error(`Failed to move job to DLQ: ${dlqError.message}`);
      }

      // Mark completion in retry state
      if (retryState) {
        retryState.completedAt = new Date().toISOString();
        retryState.nextRetryAt = undefined;
        await this.saveRetryState(retryState);
      }
    }
  }

  /**
   * Calculate the backoff delay for a given attempt.
   */
  private calculateBackoffDelay(
    backoffType: 'exponential' | 'fixed',
    baseDelay: number,
    attempt: number,
  ): number {
    if (backoffType === 'fixed') {
      return baseDelay;
    }
    // Exponential: baseDelay * 2^(attempt)  (attempt 0 = baseDelay, 1 = 2x, etc.)
    return baseDelay * Math.pow(2, attempt);
  }

  /**
   * Get current queue metrics snapshot.
   */
  getMetrics(): QueueMetrics {
    const byQueue: QueueMetrics['byQueue'] = {};
    for (const [name, counts] of this.metrics.byQueue) {
      byQueue[name] = { ...counts };
    }
    return {
      deduplicatedCount: this.metrics.deduplicatedCount,
      retryAttempts: this.metrics.retryAttempts,
      retryExhaustedCount: this.metrics.retryExhaustedCount,
      byQueue,
    };
  }

  /**
   * Map Bull job state to JobStatus enum
   */
  private mapJobState(state: string): JobStatus {
    switch (state) {
      case 'pending':
        return JobStatus.PENDING;
      case 'active':
        return JobStatus.ACTIVE;
      case 'completed':
        return JobStatus.COMPLETED;
      case 'failed':
        return JobStatus.FAILED;
      case 'delayed':
        return JobStatus.DELAYED;
      default:
        return JobStatus.PENDING;
    }
  }
}
