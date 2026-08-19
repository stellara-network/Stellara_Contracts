import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Workflow } from '../entities/workflow.entity';
import { WorkflowStep } from '../entities/workflow-step.entity';
import { WorkflowExecutionService } from './workflow-execution.service';
import { WorkflowStateMachineService } from './workflow-state-machine.service';
import { WorkflowState } from '../types/workflow-state.enum';
import { StepState } from '../types/step-state.enum';
import { QueueService } from '../../queue/services/queue.service';

@Injectable()
export class RecoveryService implements OnModuleInit {
  private readonly logger = new Logger(RecoveryService.name);
  private isRecovering = false;

  constructor(
    @InjectRepository(Workflow)
    private readonly workflowRepository: Repository<Workflow>,
    @InjectRepository(WorkflowStep)
    private readonly stepRepository: Repository<WorkflowStep>,
    private readonly workflowExecutionService: WorkflowExecutionService,
    private readonly stateMachine: WorkflowStateMachineService,
    private readonly queueService: QueueService,
  ) {}

  async onModuleInit() {
    // Perform initial recovery when module starts
    await this.performStartupRecovery();
  }

  /**
   * Perform recovery operations when service starts
   */
  async performStartupRecovery(): Promise<void> {
    if (this.isRecovering) {
      this.logger.warn(
        'Recovery already in progress, skipping startup recovery',
      );
      return;
    }

    this.isRecovering = true;
    this.logger.log('Starting startup recovery process');

    try {
      await this.recoverOrphanedWorkflows();
      await this.recoverStuckSteps();
      await this.recoverFromQueueFailures();
      await this.cleanupExpiredWorkflows();

      this.logger.log('Startup recovery completed successfully');
    } catch (error) {
      this.logger.error('Startup recovery failed', error);
    } finally {
      this.isRecovering = false;
    }
  }

  /**
   * Recover workflows that were running when the service crashed
   */
  async recoverOrphanedWorkflows(): Promise<void> {
    this.logger.log('Recovering orphaned workflows');

    // Find workflows in RUNNING state that may have been abandoned
    const orphanedWorkflows = await this.workflowRepository.find({
      where: { state: WorkflowState.RUNNING },
      relations: { steps: true },
    });

    this.logger.log(
      `Found ${orphanedWorkflows.length} potentially orphaned workflows`,
    );

    for (const workflow of orphanedWorkflows) {
      try {
        await this.recoverWorkflow(workflow);
      } catch (error) {
        this.logger.error(`Failed to recover workflow ${workflow.id}:`, error);
      }
    }
  }

  /**
   * Recover a specific workflow
   */
  private async recoverWorkflow(workflow: Workflow): Promise<void> {
    this.logger.log(`Recovering workflow: ${workflow.id}`);

    // Check if workflow has been stale for too long (potential crash)
    const stalenessThreshold = 5 * 60 * 1000; // 5 minutes
    const lastActivity = workflow.updatedAt.getTime();
    const now = Date.now();

    if (now - lastActivity < stalenessThreshold) {
      this.logger.debug(
        `Workflow ${workflow.id} is still active, skipping recovery`,
      );
      return;
    }

    // Find the last completed step
    const lastCompletedStep = workflow.steps
      .filter((step) => step.state === StepState.COMPLETED)
      .reduce(
        (latest, step) =>
          !latest || step.stepIndex > latest.stepIndex ? step : latest,
        null as WorkflowStep | null,
      );

    // Find any failed steps
    const failedSteps = workflow.steps.filter(
      (step) => step.state === StepState.FAILED,
    );

    if (failedSteps.length > 0) {
      this.logger.log(
        `Workflow ${workflow.id} has failed steps, marking as failed`,
      );
      workflow.state = WorkflowState.FAILED;
      workflow.failureReason = 'Workflow failed during service interruption';
      workflow.failedAt = new Date();
      await this.workflowRepository.save(workflow);
      return;
    }

    if (lastCompletedStep) {
      // Resume from the next step
      workflow.currentStepIndex = lastCompletedStep.stepIndex + 1;
      this.logger.log(
        `Resuming workflow ${workflow.id} from step index ${workflow.currentStepIndex}`,
      );
    } else {
      // No steps completed, start from beginning
      workflow.currentStepIndex = 0;
      this.logger.log(`Restarting workflow ${workflow.id} from beginning`);
    }

    // Restart workflow execution
    await this.workflowExecutionService.executeWorkflow(workflow);
  }

  /**
   * Recover steps that appear to be stuck
   */
  async recoverStuckSteps(): Promise<void> {
    this.logger.log('Recovering stuck steps');

    // Find steps that have been in RUNNING state for too long
    const stalenessThreshold = 10 * 60 * 1000; // 10 minutes
    const cutoffTime = new Date(Date.now() - stalenessThreshold);

    const stuckSteps = await this.stepRepository.find({
      where: {
        state: StepState.RUNNING,
        updatedAt: LessThan(cutoffTime),
      },
      relations: { workflow: true },
    });

    this.logger.log(`Found ${stuckSteps.length} potentially stuck steps`);

    for (const step of stuckSteps) {
      try {
        await this.recoverStuckStep(step);
      } catch (error) {
        this.logger.error(`Failed to recover step ${step.id}:`, error);
      }
    }
  }

  /**
   * Recover a specific stuck step
   */
  private async recoverStuckStep(step: WorkflowStep): Promise<void> {
    this.logger.log(`Recovering stuck step: ${step.id} (${step.stepName})`);

    // Check if the workflow is still active
    const workflow = step.workflow;
    if (workflow.state !== WorkflowState.RUNNING) {
      this.logger.debug(
        `Workflow ${workflow.id} is not running, skipping step recovery`,
      );
      return;
    }

    // Mark step as failed due to timeout
    step.state = StepState.FAILED;
    step.failedAt = new Date();
    step.failureReason = 'Step timed out during service interruption';
    step.retryCount += 1;

    // Check if we should retry based on retry policy
    if (
      this.stateMachine.shouldRetry(
        StepState.FAILED,
        step.retryCount,
        step.maxRetries,
      )
    ) {
      step.nextRetryAt = this.stateMachine.calculateNextRetryTime(
        step.retryCount,
      );
      this.logger.log(`Scheduling retry for stuck step: ${step.stepName}`);
    } else {
      // Mark workflow as failed if step cannot be retried
      workflow.state = WorkflowState.FAILED;
      workflow.failedAt = new Date();
      workflow.failureReason = `Step ${step.stepName} failed after max retries`;
      await this.workflowRepository.save(workflow);
      this.logger.log(
        `Workflow ${workflow.id} marked as failed due to stuck step`,
      );
    }

    await this.stepRepository.save(step);
  }

  /**
   * Clean up expired workflows and steps
   */
  async cleanupExpiredWorkflows(): Promise<void> {
    this.logger.log('Cleaning up expired workflows');

    // Clean up workflows older than retention period
    const retentionDays = 30;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const expiredWorkflows = await this.workflowRepository.find({
      where: {
        createdAt: LessThan(cutoffDate),
        state: WorkflowState.COMPLETED,
      },
    });

    this.logger.log(
      `Found ${expiredWorkflows.length} expired workflows to clean up`,
    );

    // In a production system, you might want to archive these instead of deleting
    // For now, we'll just log them
    for (const workflow of expiredWorkflows) {
      this.logger.debug(
        `Expired workflow: ${workflow.id} (created: ${workflow.createdAt})`,
      );
    }
  }

  /**
   * Scheduled recovery task - runs periodically to catch any missed recoveries
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async scheduledRecovery(): Promise<void> {
    if (this.isRecovering) {
      this.logger.debug(
        'Recovery already in progress, skipping scheduled recovery',
      );
      return;
    }

    this.isRecovering = true;
    this.logger.debug('Running scheduled recovery');

    try {
      await this.recoverOrphanedWorkflows();
      await this.recoverStuckSteps();
      await this.recoverFromQueueFailures();
    } catch (error) {
      this.logger.error('Scheduled recovery failed', error);
    } finally {
      this.isRecovering = false;
    }
  }

  /**
   * Manual recovery trigger (for admin use)
   */
  async triggerManualRecovery(): Promise<{
    orphanedWorkflows: number;
    stuckSteps: number;
    expiredWorkflows: number;
  }> {
    this.logger.log('Manual recovery triggered by admin');

    const results = {
      orphanedWorkflows: 0,
      stuckSteps: 0,
      expiredWorkflows: 0,
    };

    try {
      await this.recoverOrphanedWorkflows();
      results.orphanedWorkflows =
        (await this.workflowRepository.count({
          where: { state: WorkflowState.RUNNING },
        })) || 0;

      await this.recoverStuckSteps();
      const stuckSteps = await this.stepRepository.find({
        where: { state: StepState.RUNNING },
      });
      results.stuckSteps = stuckSteps.length;

      await this.recoverFromQueueFailures();

      await this.cleanupExpiredWorkflows();
      // Count would require a separate query with date filtering
    } catch (error) {
      this.logger.error('Manual recovery failed', error);
      throw error;
    }

    return results;
  }

  /**
   * Get recovery statistics
   */
  async getRecoveryStats(): Promise<{
    totalWorkflows: number;
    runningWorkflows: number;
    stuckSteps: number;
    failedWorkflows: number;
    lastRecoveryRun: Date | null;
  }> {
    const totalWorkflows = await this.workflowRepository.count();
    const runningWorkflows = await this.workflowRepository.count({
      where: { state: WorkflowState.RUNNING },
    });

    const stuckSteps = await this.stepRepository.count({
      where: { state: StepState.RUNNING },
    });

    const failedWorkflows = await this.workflowRepository.count({
      where: { state: WorkflowState.FAILED },
    });

    // In a real implementation, you'd track the last recovery run time
    const lastRecoveryRun = null;

    return {
      totalWorkflows,
      runningWorkflows,
      stuckSteps,
      failedWorkflows,
      lastRecoveryRun,
    };
  }

  /**
   * Recover workflows from queue failures by checking DLQ
   */
  async recoverFromQueueFailures(): Promise<void> {
    this.logger.log('Recovering workflows from queue failures');
    const queuesToCheck = [
      'deploy-contract',
      'process-tts',
      'index-market-news',
    ];

    for (const queueName of queuesToCheck) {
      try {
        const dlqItems = await this.queueService.getDeadLetterQueue(
          queueName,
          100,
        );

        for (const item of dlqItems) {
          const jobData = typeof item === 'string' ? JSON.parse(item) : item;
          // Look for workflow metadata in the failed job
          const workflowId =
            jobData?.data?.workflowId || jobData?.data?.context?.workflowId;
          const stepIndex =
            jobData?.data?.stepIndex || jobData?.data?.context?.stepIndex;

          if (workflowId) {
            const workflow = await this.workflowRepository.findOne({
              where: { id: workflowId },
              relations: { steps: true },
            });

            if (workflow && workflow.state === WorkflowState.RUNNING) {
              this.logger.log(
                `Found failed queue job for running workflow ${workflowId}`,
              );

              const step =
                workflow.steps.find((s) => s.stepIndex === stepIndex) ||
                workflow.steps.find((s) => s.state === StepState.RUNNING);

              if (step && step.state === StepState.RUNNING) {
                step.state = StepState.FAILED;
                step.failedAt = new Date();
                step.failureReason = `Queue job failed in ${queueName}: ${jobData.error || 'Unknown error'}`;
                step.retryCount += 1;

                if (
                  this.stateMachine.shouldRetry(
                    StepState.FAILED,
                    step.retryCount,
                    step.maxRetries,
                  )
                ) {
                  step.nextRetryAt = this.stateMachine.calculateNextRetryTime(
                    step.retryCount,
                  );
                  this.logger.log(
                    `Scheduling retry for step: ${step.stepName}`,
                  );
                } else {
                  workflow.state = WorkflowState.FAILED;
                  workflow.failedAt = new Date();
                  workflow.failureReason = `Step ${step.stepName} failed after max queue retries`;
                  await this.workflowRepository.save(workflow);
                }

                await this.stepRepository.save(step);
              }
            }
          }
        }
      } catch (error) {
        this.logger.error(`Failed to recover from queue ${queueName}`, error);
      }
    }
  }
}
