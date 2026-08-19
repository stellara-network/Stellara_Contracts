import { Processor, Process, OnQueueFailed } from '@nestjs/bull';
import type { Job } from 'bull';
import { Inject, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { JobResult } from '../types/job.types';
import { ValidationError, TransientError } from '../types/errors';
import { MetricsService } from '../../observability/services/metrics.service';
import { QueueJobTracingWrapper } from '../../observability/middleware/queue-job-tracing.wrapper';
import { QueueIdempotencyGuard } from '../queue-idempotency.guard';

interface DeployContractData {
  contractName: string;
  contractCode: string;
  network: string;
  initializer?: string;
  /**
   * Optional idempotency key passed through the pipeline. The processor
   * validates it before execution to guard against duplicate processing
   * when a job is re-dispatched or the guard layer was bypassed.
   */
  idempotencyKey?: string;
}

@Processor('deploy-contract')
export class DeployContractProcessor {
  private readonly logger = new Logger(DeployContractProcessor.name);

  constructor(
    @InjectQueue('failed-jobs') private readonly dlqQueue: Queue,
    private readonly queueJobTracingWrapper: QueueJobTracingWrapper,
    private readonly idempotencyGuard: QueueIdempotencyGuard,
    @Optional() @Inject(MetricsService) private readonly metrics?: MetricsService,
  ) {}

  @Process()
  async handleDeployContract(job: Job<DeployContractData>): Promise<JobResult> {
    // Wrap the actual processing in the tracing wrapper
    const wrappedProcess = this.queueJobTracingWrapper.wrapProcessor(
      async (jobToProcess: Job<DeployContractData>) => {
        // Validate idempotency key before processing. If the job carries a
        // key that was already claimed by another worker, skip execution.
        const providedKey = jobToProcess.data.idempotencyKey;
        if (providedKey) {
          const existing = await this.idempotencyGuard.isDuplicate(providedKey);
          if (existing.isDuplicate && existing.jobId !== jobToProcess.id) {
            this.logger.warn(
              `Skipping duplicate deploy-contract job ${jobToProcess.id} — ` +
              `idempotency key already claimed by job ${existing.jobId}`,
            );
            return {
              success: true,
              data: { skipped: true, reason: 'duplicate', claimedBy: existing.jobId },
            };
          }
        }

        const { contractName, contractCode, network, initializer } = jobToProcess.data;
        const start = Date.now();
        const correlationId =
          (jobToProcess.data as any)?.correlationId ||
          'deploy-contract-' + (jobToProcess as any).id;

        this.logger.log(
          `Processing deploy-contract job ${jobToProcess.id}: ${contractName} on ${network}`,
        );

        this.metrics?.recordJobStart('deploy-contract', correlationId);

        try {
          await jobToProcess.progress(10);

          if (!contractName || !contractCode || !network) {
            throw new ValidationError(
              'Missing required fields: contractName, contractCode, network',
            );
          }

          this.logger.debug(`Deploying contract ${contractName}...`);
          await jobToProcess.progress(30);

          const compilationResult = await this.compileContract(contractCode);
          if (!compilationResult.success) {
            throw new TransientError(
              `Compilation failed: ${compilationResult.error}`,
            );
          }

          await jobToProcess.progress(50);

          const deploymentResult = await this.deployToNetwork(
            compilationResult.bytecode!,
            network,
            initializer,
          );

          await jobToProcess.progress(90);

          if (deploymentResult.contractAddress) {
            this.logger.log(
              `Contract deployed successfully at ${deploymentResult.contractAddress}`,
            );
          }

          await jobToProcess.progress(100);

          const duration = (Date.now() - start) / 1000;
          this.metrics?.recordJobCompleted(
            'deploy-contract',
            duration,
            correlationId,
          );

          return {
            success: true,
            data: {
              contractAddress: deploymentResult.contractAddress,
              transactionHash: deploymentResult.transactionHash,
              network,
              contractName,
              deployedAt: new Date().toISOString(),
            },
          };
        } catch (error) {
          const duration = (Date.now() - start) / 1000;
          this.metrics?.recordJobFailed(
            'deploy-contract',
            duration,
            error.constructor.name,
            correlationId,
          );
          this.logger.error(
            `Failed to deploy contract: ${error.message}`,
            error.stack,
          );
          throw error;
        }
      },
      'deploy-contract',
    );

    return wrappedProcess(job);
  }

  /**
   * Route permanently failed jobs to the DLQ after all retry attempts
   * are exhausted, or immediately for non-retryable errors.
   */
  @OnQueueFailed()
  async onFailed(job: Job<DeployContractData>, err: Error): Promise<void> {
    const attemptsExhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    const isPermanent = (err as any).retryable === false;

    if (attemptsExhausted || isPermanent) {
      this.logger.error(
        `Job ${job.id} exhausted retries or is permanent — routing to DLQ`,
        err.stack,
      );
      await this.dlqQueue.add({
        originalQueue: 'deploy-contract',
        originalJobId: job.id,
        failedReason: err.message,
        payload: job.data,
      });
    }
  }

  private async compileContract(
    contractCode: string,
  ): Promise<{ success: boolean; bytecode?: string; error?: string }> {
    return new Promise((resolve) => {
      setTimeout(() => {
        if (contractCode.length === 0) {
          resolve({ success: false, error: 'Empty contract code' });
        } else {
          resolve({
            success: true,
            bytecode: Buffer.from(contractCode).toString('base64'),
          });
        }
      }, 1000);
    });
  }

  private async deployToNetwork(
    bytecode: string,
    network: string,
    initializer?: string,
  ): Promise<{ contractAddress: string; transactionHash: string }> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          contractAddress: `0x${Math.random().toString(16).slice(2).padEnd(40, '0')}`,
          transactionHash: `0x${Math.random().toString(16).slice(2).padEnd(64, '0')}`,
        });
      }, 2000);
    });
  }
}
