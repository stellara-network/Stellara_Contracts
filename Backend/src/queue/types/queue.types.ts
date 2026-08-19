/**
 * Metrics exposed by the queue service for operator dashboards.
 */
export interface QueueMetrics {
  /** Total jobs deduplicated within the current observation window */
  deduplicatedCount: number;
  /** Total retry attempts across all queues */
  retryAttempts: number;
  /** Jobs that exhausted all retries and landed in DLQ */
  retryExhaustedCount: number;
  /** Per-queue breakdown */
  byQueue: Record<
    string,
    {
      submitted: number;
      deduplicated: number;
      retried: number;
      failed: number;
    }
  >;
}

/**
 * Structured metadata stored alongside every DLQ entry so operators can
 * inspect the full context of a permanently failed job.
 */
export interface DlqEntry {
  /** Bull job id */
  id: string | number;
  /** Job name / handler identifier */
  name: string;
  /** Original queue the job belonged to */
  queueName: string;
  /** Serialized job payload */
  data: Record<string, any>;
  /** Final error message */
  errorMessage: string;
  /** Error stack trace (truncated to 4 KB) */
  errorStack?: string;
  /** Error class name, e.g. "TransientError", "ValidationError" */
  errorType?: string;
  /** Whether the error was marked retryable */
  retryable: boolean;
  /** Total attempts made */
  attempts: number;
  /** Maximum attempts configured */
  maxAttempts: number;
  /** ISO-8601 timestamp of permanent failure */
  failedAt: string;
  /** Idempotency key that was used for this job */
  idempotencyKey?: string;
  /** Full retry state snapshot at time of failure */
  retryState?: import('./job.types').RetryState;
}
