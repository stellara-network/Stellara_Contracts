export interface JobData {
  [key: string]: any;
}

export interface JobResult {
  success: boolean;
  data?: any;
  error?: string;
}

export interface JobConfig {
  attempts: number;
  backoff: {
    type: 'exponential' | 'fixed';
    delay: number;
  };
  timeout: number;
  concurrency: number;
  removeOnComplete: boolean;
  removeOnFail: boolean;
}

export enum JobStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  FAILED = 'failed',
  DELAYED = 'delayed',
}

export interface JobInfo {
  id: string;
  name: string;
  status: JobStatus;
  progress: number;
  attempts: number;
  maxAttempts: number;
  data: JobData;
  result?: JobResult;
  error?: string;
  createdAt: Date;
  processedAt?: Date;
  completedAt?: Date;
  retryState?: RetryState;
}

export interface RetryState {
  jobId: string;
  queueName: string;
  jobName: string;
  attemptCount: number;
  maxAttempts: number;
  lastError?: string;
  lastErrorStack?: string;
  lastErrorType?: string;
  /** Whether the last error was marked retryable */
  lastRetryable?: boolean;
  firstAttemptedAt: string;
  lastAttemptedAt: string;
  completedAt?: string;
  idempotencyKey: string;
  /** Backoff strategy used for retries */
  backoffType: 'exponential' | 'fixed';
  /** Base delay in milliseconds between retries */
  backoffDelay: number;
  /** ISO-8601 timestamp of the next scheduled retry, if any */
  nextRetryAt?: string;
}

export interface IdempotencyResult {
  isDuplicate: boolean;
  jobId?: string | number;
}
