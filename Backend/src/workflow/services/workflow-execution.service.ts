import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { randomUUID } from 'crypto';
import { Workflow } from '../entities/workflow.entity';
import { WorkflowStep } from '../entities/workflow-step.entity';
import { WorkflowDefinition, StepDefinition, WorkflowContext } from '../types';
import { WorkflowState } from '../types/workflow-state.enum';
import { StepState } from '../types/step-state.enum';
import { WorkflowStateMachineService } from './workflow-state-machine.service';
import { IdempotencyService } from './idempotency.service';
import { CompensationService } from './compensation.service';
import { RedisService } from '../../redis/redis.service';

class WorkflowTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowTimeoutError';
  }
}

@Injectable()
export class WorkflowExecutionService {
  private readonly logger = new Logger(WorkflowExecutionService.name);
  private readonly workflowDefinitions = new Map<string, WorkflowDefinition>();

  constructor(
    @InjectRepository(Workflow)
    private readonly workflowRepository: Repository<Workflow>,
    @InjectRepository(WorkflowStep)
    private readonly stepRepository: Repository<WorkflowStep>,
    private readonly stateMachine: WorkflowStateMachineService,
    private readonly idempotencyService: IdempotencyService,
    private readonly compensationService: CompensationService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Register a workflow definition
   */
  registerWorkflowDefinition(definition: WorkflowDefinition): void {
    const version = definition.version || 1;
    const key = `${definition.type}:v${version}`;
    this.workflowDefinitions.set(key, definition);

    // Track the latest version
    const latestKey = `${definition.type}:latest`;
    const currentLatest = this.workflowDefinitions.get(latestKey);
    if (!currentLatest || (currentLatest.version || 1) <= version) {
      this.workflowDefinitions.set(latestKey, definition);
    }

    this.logger.log(
      `Registered workflow definition: ${definition.type} v${version}`,
    );
  }

  /**
   * Get workflow definition by type and optional version
   */
  getWorkflowDefinition(
    type: string,
    version?: number,
  ): WorkflowDefinition | undefined {
    if (version !== undefined) {
      return this.workflowDefinitions.get(`${type}:v${version}`);
    }
    return this.workflowDefinitions.get(`${type}:latest`);
  }

  /**
   * Start a new workflow
   */
  async startWorkflow(
    type: string,
    input: Record<string, any>,
    userId?: string,
    walletAddress?: string,
    context?: Record<string, any>,
  ): Promise<Workflow> {
    const definition = this.getWorkflowDefinition(type);
    if (!definition) {
      throw new Error(`Workflow definition not found for type: ${type}`);
    }
    const version = definition.version || 1;

    // Generate idempotency key
    const idempotencyKey =
      this.idempotencyService.generateWorkflowIdempotencyKey(
        type,
        userId || 'anonymous',
        input,
        context,
      );

    // Check for existing workflow with same idempotency key
    const existingWorkflow = await this.workflowRepository.findOne({
      where: { idempotencyKey },
      relations: { steps: true },
    });

    if (existingWorkflow) {
      this.logger.log(
        `Found existing workflow ${existingWorkflow.id} for idempotency key: ${idempotencyKey}`,
      );
      return existingWorkflow;
    }

    const lockKey = this.getWorkflowLockKey(idempotencyKey);
    const lockToken = randomUUID();
    const lockAcquired = await this.acquireWorkflowLock(lockKey, lockToken);

    if (!lockAcquired) {
      const lockedWorkflow = await this.waitForWorkflow(
        idempotencyKey,
        5000,
        100,
      );

      if (lockedWorkflow) {
        this.logger.log(
          `Returning workflow created by another worker for idempotency key: ${idempotencyKey}`,
        );
        return lockedWorkflow;
      }

      throw new Error(
        `Workflow already being processed for idempotency key: ${idempotencyKey}`,
      );
    }

    try {
      // Create new workflow
      const workflow = this.workflowRepository.create({
        idempotencyKey,
        type: type as any,
        version,
        definition: this.serializeDefinition(definition),
        input,
        userId,
        walletAddress,
        context,
        totalSteps: definition.steps.length,
        maxRetries: definition.maxRetries || 3,
        requiresCompensation: definition.requiresCompensation || false,
      });

      const savedWorkflow = await this.workflowRepository.save(workflow);

      // Create workflow steps
      const steps = definition.steps.map((stepDef, index) => {
        return this.stepRepository.create({
          workflowId: savedWorkflow.id,
          stepName: stepDef.name,
          stepIndex: index,
          config: stepDef.config,
          requiresCompensation: !!stepDef.compensate,
          isIdempotent: stepDef.isIdempotent,
          maxRetries: stepDef.maxRetries || 3,
        });
      });

      await this.stepRepository.save(steps);

      // Start execution
      await this.executeWorkflow(savedWorkflow);

      return (
        (await this.workflowRepository.findOne({
          where: { id: savedWorkflow.id },
          relations: { steps: true },
        })) ?? savedWorkflow
      );
    } finally {
      await this.releaseWorkflowLock(lockKey, lockToken);
    }
  }

  /**
   * Execute a workflow
   */
  async executeWorkflow(workflow: Workflow): Promise<void> {
    const definition = this.getWorkflowDefinition(
      workflow.type,
      workflow.version,
    );
    if (!definition) {
      throw new Error(
        `Workflow definition not found for type: ${workflow.type} v${workflow.version}`,
      );
    }

    // Update workflow state to RUNNING
    const transition = this.stateMachine.transitionWorkflow(
      workflow.state,
      WorkflowState.RUNNING,
    );
    if (!transition.success) {
      throw new Error(`Cannot start workflow: ${transition.error}`);
    }

    workflow.state = WorkflowState.RUNNING;
    workflow.startedAt = new Date();
    await this.workflowRepository.save(workflow);

    this.logger.log(`Starting workflow execution: ${workflow.id}`);

    try {
      await this.executeSteps(workflow, definition);

      // Mark workflow as completed
      workflow.state = WorkflowState.COMPLETED;
      workflow.completedAt = new Date();
      await this.workflowRepository.save(workflow);

      this.logger.log(`Workflow completed successfully: ${workflow.id}`);
    } catch (error) {
      if (error instanceof WorkflowTimeoutError) {
        this.logger.warn(
          `Workflow timed out and will rely on automatic compensation: ${workflow.id}`,
        );
        return;
      }

      this.logger.error(`Workflow failed: ${workflow.id}`, error);

      workflow.state = WorkflowState.FAILED;
      workflow.failedAt = new Date();
      workflow.failureReason =
        error instanceof Error ? error.message : 'Unknown workflow failure';
      await this.workflowRepository.save(workflow);

      throw error;
    }
  }

  /**
   * Execute all steps in a workflow
   */
  private async executeSteps(
    workflow: Workflow,
    definition: WorkflowDefinition,
  ): Promise<void> {
    const steps = await this.stepRepository.find({
      where: { workflowId: workflow.id },
      order: { stepIndex: 'ASC' },
    });

    for (const step of steps) {
      workflow.currentStepIndex = step.stepIndex;
      await this.workflowRepository.save(workflow);

      await this.executeStep(
        workflow,
        step,
        definition.steps[step.stepIndex],
        definition.timeout,
      );
    }
  }

  /**
   * Execute a single step
   */
  private async executeStep(
    workflow: Workflow,
    step: WorkflowStep,
    stepDefinition: StepDefinition,
    workflowTimeout?: number,
  ): Promise<void> {
    this.logger.debug(
      `Executing step: ${step.stepName} for workflow: ${workflow.id}`,
    );

    // Update step state to RUNNING
    const transition = this.stateMachine.transitionStep(
      step.state,
      StepState.RUNNING,
    );
    if (!transition.success) {
      throw new Error(`Cannot execute step: ${transition.error}`);
    }

    step.state = StepState.RUNNING;
    step.startedAt = new Date();
    await this.stepRepository.save(step);

    try {
      // Generate step context
      const context: WorkflowContext = {
        workflowId: workflow.id,
        idempotencyKey: workflow.idempotencyKey,
        userId: workflow.userId,
        walletAddress: workflow.walletAddress,
        type: workflow.type,
        retryCount: step.retryCount,
        stepIndex: step.stepIndex,
        metadata: workflow.context,
        resumableState: step.resumableState,
        updateState: async (state: Record<string, any>) => {
          step.resumableState = { ...step.resumableState, ...state };
          await this.stepRepository.save(step);
        },
      };

      // Prepare step input
      const stepInput = this.prepareStepInput(workflow, step, stepDefinition);

      // Generate step idempotency key if step is idempotent
      let stepIdempotencyKey: string | undefined;
      if (step.isIdempotent) {
        stepIdempotencyKey = this.idempotencyService.generateStepIdempotencyKey(
          workflow.idempotencyKey,
          step.stepName,
          stepInput,
        );
        step.idempotencyKey = stepIdempotencyKey;
        await this.stepRepository.save(step);
      }

      const timeoutMs = stepDefinition.timeout ?? workflowTimeout;

      // Execute step with timeout and idempotency protection
      const output = await this.executeStepWithTimeout(
        () =>
          this.executeWithIdempotency(
            stepDefinition,
            stepInput,
            context,
            stepIdempotencyKey,
          ),
        timeoutMs,
        step.stepName,
      );

      // Update step with successful result
      step.state = StepState.COMPLETED;
      step.output = output;
      step.completedAt = new Date();
      await this.stepRepository.save(step);

      this.logger.debug(`Step completed successfully: ${step.stepName}`);
    } catch (error) {
      if (error instanceof WorkflowTimeoutError) {
        step.state = StepState.FAILED;
        step.failedAt = new Date();
        step.failureReason = error.message;
        step.retryCount += 1;
        await this.stepRepository.save(step);

        this.logger.warn(
          `Step timed out, triggering compensation: ${step.stepName} for workflow ${workflow.id}`,
        );

        await this.compensationService.compensateWorkflow(workflow.id);
        throw error;
      }

      this.logger.error(`Step failed: ${step.stepName}`, error);

      step.state = StepState.FAILED;
      step.failedAt = new Date();
      step.failureReason =
        error instanceof Error ? error.message : 'Unknown step failure';
      step.retryCount += 1;

      // Check if we should retry
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
        await this.stepRepository.save(step);

        this.logger.log(
          `Scheduling retry for step: ${step.stepName}, attempt: ${step.retryCount}`,
        );

        // Wait for retry delay
        await this.delay(step.nextRetryAt.getTime() - Date.now());

        // Retry the step
        await this.executeStep(workflow, step, stepDefinition);
      } else {
        await this.stepRepository.save(step);
        throw new Error(
          `Step ${step.stepName} failed after ${step.retryCount} retries: ${error.message}`,
        );
      }
    }
  }

  /**
   * Execute step with idempotency protection
   */
  private async executeWithIdempotency(
    stepDefinition: StepDefinition,
    input: any,
    context: WorkflowContext,
    idempotencyKey?: string,
  ): Promise<any> {
    if (!stepDefinition.isIdempotent || !idempotencyKey) {
      return await stepDefinition.execute(input, context);
    }

    // For idempotent steps, we would check for previous execution
    // This is a simplified implementation - in production, you'd use a distributed cache
    return await stepDefinition.execute(input, context);
  }

  /**
   * Execute a step with an optional timeout.
   */
  private async executeStepWithTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number | undefined,
    stepName: string,
  ): Promise<T> {
    if (!timeoutMs || timeoutMs <= 0) {
      return await operation();
    }

    return await new Promise<T>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        reject(
          new WorkflowTimeoutError(
            `Step ${stepName} exceeded timeout of ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      operation()
        .then((result) => {
          clearTimeout(timeoutHandle);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutHandle);
          reject(error);
        });
    });
  }

  /**
   * Prepare step input based on workflow input and previous step outputs
   */
  private async prepareStepInput(
    workflow: Workflow,
    step: WorkflowStep,
    stepDefinition: StepDefinition,
  ): Promise<any> {
    // Start with workflow input
    const stepInput = { ...workflow.input };

    // Add outputs from previous steps
    if (step.stepIndex > 0) {
      const previousSteps = await this.stepRepository.find({
        where: {
          workflowId: workflow.id,
          stepIndex: LessThan(step.stepIndex),
        },
        order: { stepIndex: 'ASC' },
      });

      previousSteps.forEach((prevStep) => {
        if (prevStep.output) {
          stepInput[prevStep.stepName] = prevStep.output;
        }
      });
    }

    return stepInput;
  }

  /**
   * Retry a failed workflow
   */
  async retryWorkflow(workflowId: string): Promise<void> {
    const workflow = await this.workflowRepository.findOne({
      where: { id: workflowId },
      relations: { steps: true },
    });

    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    if (!this.stateMachine.isWorkflowRecoverable(workflow.state)) {
      throw new Error(`Workflow ${workflowId} is not in a recoverable state`);
    }

    // Reset workflow state
    workflow.state = WorkflowState.RUNNING;
    workflow.retryCount += 1;
    workflow.startedAt = new Date();
    workflow.failedAt = undefined;
    workflow.failureReason = undefined;

    await this.workflowRepository.save(workflow);

    // Find the failed step and retry from there
    const failedStep = workflow.steps.find(
      (step) => step.state === StepState.FAILED,
    );
    if (failedStep) {
      failedStep.state = StepState.PENDING;
      failedStep.failedAt = undefined;
      failedStep.failureReason = undefined;
      await this.stepRepository.save(failedStep);
    }

    // Resume execution
    await this.executeWorkflow(workflow);
  }

  /**
   * Cancel a workflow
   */
  async cancelWorkflow(workflowId: string): Promise<void> {
    const workflow = await this.workflowRepository.findOne({
      where: { id: workflowId },
    });

    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const transition = this.stateMachine.transitionWorkflow(
      workflow.state,
      WorkflowState.CANCELLED,
    );
    if (!transition.success) {
      throw new Error(`Cannot cancel workflow: ${transition.error}`);
    }

    workflow.state = WorkflowState.CANCELLED;
    workflow.completedAt = new Date();
    await this.workflowRepository.save(workflow);

    this.logger.log(`Workflow cancelled: ${workflowId}`);
  }

  /**
   * Compensate a workflow
   */
  async compensateWorkflow(workflowId: string): Promise<void> {
    // This will be handled by the CompensationService
    throw new Error('Use CompensationService.compensateWorkflow() instead');
  }

  /**
   * Helper function to delay execution
   */
  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getWorkflowLockKey(idempotencyKey: string): string {
    return `workflow:lock:${idempotencyKey}`;
  }

  private async acquireWorkflowLock(
    lockKey: string,
    token: string,
    ttlSeconds: number = 3600,
  ): Promise<boolean> {
    const result = await this.redisService.client.set(lockKey, token, {
      NX: true,
      EX: ttlSeconds,
    });

    return result === 'OK';
  }

  private async releaseWorkflowLock(
    lockKey: string,
    token: string,
  ): Promise<void> {
    try {
      const currentToken = await this.redisService.client.get(lockKey);
      if (currentToken === token) {
        await this.redisService.client.del(lockKey);
      }
    } catch (error) {
      this.logger.warn(
        `Failed to release workflow lock ${lockKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async waitForWorkflow(
    idempotencyKey: string,
    timeoutMs: number,
    intervalMs: number,
  ): Promise<Workflow | null> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const workflow = await this.workflowRepository.findOne({
        where: { idempotencyKey },
        relations: { steps: true },
      });

      if (workflow) {
        return workflow;
      }

      await this.delay(intervalMs);
    }

    return null;
  }

  /**
   * Serialize workflow definition (removes functions)
   */
  private serializeDefinition(
    definition: WorkflowDefinition,
  ): Record<string, any> {
    const serialized = { ...definition };
    serialized.steps = serialized.steps.map((step) => {
      const { execute, compensate, ...rest } = step;
      return rest as any;
    });
    return serialized as Record<string, any>;
  }
}
