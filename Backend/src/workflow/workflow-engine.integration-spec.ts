import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkflowService } from './services/workflow.service';
import { WorkflowExecutionService } from './services/workflow-execution.service';
import { WorkflowStateMachineService } from './services/workflow-state-machine.service';
import { IdempotencyService } from './services/idempotency.service';
import { CompensationService } from './services/compensation.service';
import { RecoveryService } from './services/recovery.service';
import { MonitoringService } from './services/monitoring.service';
import { RedisService } from '../redis/redis.service';
import { Workflow } from './entities/workflow.entity';
import { WorkflowStep } from './entities/workflow-step.entity';
import { WorkflowState } from './types/workflow-state.enum';
import { StepState } from './types/step-state.enum';
import { WorkflowDefinition } from './types';

describe('Workflow Engine Integration', () => {
  let workflowService: WorkflowService;
  let workflowExecutionService: WorkflowExecutionService;
  let workflowRepository: Repository<Workflow>;
  let stepRepository: Repository<WorkflowStep>;
  let mockRedisClient: { set: jest.Mock; get: jest.Mock; del: jest.Mock };

  const mockWorkflowRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    findAndCount: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
    query: jest.fn(),
  };

  const mockStepRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  };

  beforeEach(async () => {
    mockRedisClient = {
      set: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowService,
        WorkflowExecutionService,
        WorkflowStateMachineService,
        IdempotencyService,
        RecoveryService,
        MonitoringService,
        {
          provide: RedisService,
          useValue: {
            client: mockRedisClient,
            pubClient: mockRedisClient,
            subClient: mockRedisClient,
          },
        },
        {
          provide: getRepositoryToken(Workflow),
          useValue: mockWorkflowRepository,
        },
        {
          provide: getRepositoryToken(WorkflowStep),
          useValue: mockStepRepository,
        },
        {
          provide: CompensationService,
          useValue: {
            compensateWorkflow: jest.fn().mockResolvedValue(undefined),
            getCompensatableWorkflows: jest.fn(),
            requiresCompensation: jest.fn(),
            forceCompensateWorkflow: jest.fn(),
          },
        },
      ],
    }).compile();

    workflowService = module.get<WorkflowService>(WorkflowService);
    workflowExecutionService = module.get<WorkflowExecutionService>(
      WorkflowExecutionService,
    );
    workflowRepository = module.get<Repository<Workflow>>(
      getRepositoryToken(Workflow),
    );
    stepRepository = module.get<Repository<WorkflowStep>>(
      getRepositoryToken(WorkflowStep),
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Core Workflow Functionality', () => {
    it('should register workflow definitions on module init', async () => {
      const spy = jest.spyOn(
        workflowExecutionService,
        'registerWorkflowDefinition',
      );

      await workflowService.onModuleInit();

      expect(spy).toHaveBeenCalledTimes(3); // contract_deployment, trade_execution, ai_job_chain
    });

    it('should generate idempotency keys correctly', () => {
      const idempotencyService = new IdempotencyService();

      const key1 = idempotencyService.generateWorkflowIdempotencyKey(
        'contract_deployment',
        'user123',
        { contractCode: '0x123' },
      );

      const key2 = idempotencyService.generateWorkflowIdempotencyKey(
        'contract_deployment',
        'user123',
        { contractCode: '0x123' },
      );

      // Same input should generate same key
      expect(key1).toBe(key2);

      const key3 = idempotencyService.generateWorkflowIdempotencyKey(
        'contract_deployment',
        'user123',
        { contractCode: '0x456' },
      );

      // Different input should generate different key
      expect(key1).not.toBe(key3);
    });

    it('should validate idempotency keys', () => {
      const idempotencyService = new IdempotencyService();

      const input = { contractCode: '0x123' };
      const key = idempotencyService.generateWorkflowIdempotencyKey(
        'contract_deployment',
        'user123',
        input,
      );

      const isValid = idempotencyService.validateIdempotencyKey(
        key,
        'contract_deployment',
        'user123',
        input,
      );

      expect(isValid).toBe(true);
    });
  });

  describe('State Machine Transitions', () => {
    let stateMachine: WorkflowStateMachineService;

    beforeEach(() => {
      stateMachine = new WorkflowStateMachineService();
    });

    it('should allow valid workflow state transitions', () => {
      // PENDING → RUNNING should be valid
      const result1 = stateMachine.canTransitionWorkflow(
        WorkflowState.PENDING,
        WorkflowState.RUNNING,
      );
      expect(result1).toBe(true);

      // RUNNING → COMPLETED should be valid
      const result2 = stateMachine.canTransitionWorkflow(
        WorkflowState.RUNNING,
        WorkflowState.COMPLETED,
      );
      expect(result2).toBe(true);

      // COMPLETED → COMPENSATING should be valid
      const result3 = stateMachine.canTransitionWorkflow(
        WorkflowState.COMPLETED,
        WorkflowState.COMPENSATING,
      );
      expect(result3).toBe(true);
    });

    it('should reject invalid workflow state transitions', () => {
      // COMPLETED → RUNNING should be invalid
      const result1 = stateMachine.canTransitionWorkflow(
        WorkflowState.COMPLETED,
        WorkflowState.RUNNING,
      );
      expect(result1).toBe(false);

      // FAILED → PENDING should be invalid
      const result2 = stateMachine.canTransitionWorkflow(
        WorkflowState.FAILED,
        WorkflowState.PENDING,
      );
      expect(result2).toBe(false);
    });

    it('should allow valid step state transitions', () => {
      // PENDING → RUNNING should be valid
      const result1 = stateMachine.canTransitionStep(
        StepState.PENDING,
        StepState.RUNNING,
      );
      expect(result1).toBe(true);

      // RUNNING → COMPLETED should be valid
      const result2 = stateMachine.canTransitionStep(
        StepState.RUNNING,
        StepState.COMPLETED,
      );
      expect(result2).toBe(true);

      // COMPLETED → COMPENSATING should be valid
      const result3 = stateMachine.canTransitionStep(
        StepState.COMPLETED,
        StepState.COMPENSATING,
      );
      expect(result3).toBe(true);
    });

    it('should determine retry eligibility correctly', () => {
      // FAILED state with retry count less than max should be retryable
      const result1 = stateMachine.shouldRetry(StepState.FAILED, 1, 3);
      expect(result1).toBe(true);

      // FAILED state with retry count equal to max should not be retryable
      const result2 = stateMachine.shouldRetry(StepState.FAILED, 3, 3);
      expect(result2).toBe(false);

      // COMPLETED state should not be retryable
      const result3 = stateMachine.shouldRetry(StepState.COMPLETED, 0, 3);
      expect(result3).toBe(false);
    });
  });

  describe('Recovery Mechanisms', () => {
    it('should detect recoverable workflows', () => {
      const stateMachine = new WorkflowStateMachineService();

      // FAILED workflows should be recoverable
      const result1 = stateMachine.isWorkflowRecoverable(WorkflowState.FAILED);
      expect(result1).toBe(true);

      // RUNNING workflows should not be recoverable (they're still active)
      const result2 = stateMachine.isWorkflowRecoverable(WorkflowState.RUNNING);
      expect(result2).toBe(false);

      // COMPLETED workflows should not be recoverable
      const result3 = stateMachine.isWorkflowRecoverable(
        WorkflowState.COMPLETED,
      );
      expect(result3).toBe(false);
    });

    it('should calculate retry delays with exponential backoff', () => {
      const stateMachine = new WorkflowStateMachineService();

      const delay1 = stateMachine.calculateNextRetryTime(0); // First retry
      const delay2 = stateMachine.calculateNextRetryTime(1); // Second retry
      const delay3 = stateMachine.calculateNextRetryTime(2); // Third retry

      // Delays should increase exponentially
      expect(delay2.getTime()).toBeGreaterThan(delay1.getTime());
      expect(delay3.getTime()).toBeGreaterThan(delay2.getTime());
    });
  });

  describe('Compensation Logic', () => {
    it('should identify compensatable workflow states', () => {
      const stateMachine = new WorkflowStateMachineService();

      // COMPLETED workflows that require compensation should be compensatable
      const result1 = stateMachine.canWorkflowCompensate(
        WorkflowState.COMPLETED,
      );
      expect(result1).toBe(true);

      // FAILED workflows that require compensation should be compensatable
      const result2 = stateMachine.canWorkflowCompensate(WorkflowState.FAILED);
      expect(result2).toBe(true);

      // PENDING workflows should not be compensatable
      const result3 = stateMachine.canWorkflowCompensate(WorkflowState.PENDING);
      expect(result3).toBe(false);
    });

    it('should identify compensatable step states', () => {
      const stateMachine = new WorkflowStateMachineService();

      // COMPLETED steps that require compensation should be compensatable
      const result1 = stateMachine.canStepCompensate(StepState.COMPLETED);
      expect(result1).toBe(true);

      // FAILED steps that require compensation should be compensatable
      const result2 = stateMachine.canStepCompensate(StepState.FAILED);
      expect(result2).toBe(true);

      // PENDING steps should not be compensatable
      const result3 = stateMachine.canStepCompensate(StepState.PENDING);
      expect(result3).toBe(false);
    });
  });

  describe('Execution Safeguards', () => {
    it('should return the existing workflow when a duplicate request arrives mid-flight', async () => {
      const workflowType = 'test_workflow';
      const workflowDefinition: WorkflowDefinition = {
        type: workflowType as any,
        name: 'Test Workflow',
        description: 'Test workflow for duplicate guard',
        steps: [
          {
            name: 'noop',
            isIdempotent: true,
            execute: jest.fn().mockResolvedValue({ ok: true }),
          },
        ],
      };

      workflowExecutionService.registerWorkflowDefinition(workflowDefinition);

      const savedWorkflow = {
        id: 'workflow-1',
        idempotencyKey: 'workflow:test_workflow:user123:hash',
        type: workflowType,
        state: WorkflowState.PENDING,
        input: { foo: 'bar' },
        steps: [],
      } as unknown as Workflow;

      let workflowPersisted = false;
      let resolveInitialSave: ((value: Workflow) => void) | undefined;
      const initialSavePromise = new Promise<Workflow>((resolve) => {
        resolveInitialSave = (value) => {
          workflowPersisted = true;
          resolve(value);
        };
      });

      mockWorkflowRepository.create.mockImplementation((entity) => ({
        ...entity,
      }));
      mockWorkflowRepository.findOne.mockImplementation(async () =>
        workflowPersisted ? savedWorkflow : null,
      );
      mockWorkflowRepository.save.mockImplementation(async (entity) => {
        if (!workflowPersisted) {
          savedWorkflow.idempotencyKey = entity.idempotencyKey;
          savedWorkflow.type = entity.type;
          savedWorkflow.input = entity.input;
          savedWorkflow.state = entity.state;
          savedWorkflow.steps = [];
          return initialSavePromise;
        }

        return entity;
      });
      mockStepRepository.create.mockImplementation((entity) => ({ ...entity }));
      mockStepRepository.save.mockResolvedValue([]);

      const executeWorkflowSpy = jest
        .spyOn(workflowExecutionService, 'executeWorkflow')
        .mockResolvedValue(undefined);

      mockRedisClient.set
        .mockResolvedValueOnce('OK')
        .mockResolvedValueOnce(null);
      mockRedisClient.get.mockResolvedValue('workflow-lock-token');
      mockRedisClient.del.mockResolvedValue(1);

      const firstCall = workflowService.startWorkflow(
        workflowType,
        { foo: 'bar' },
        'user123',
      );
      const secondCall = workflowService.startWorkflow(
        workflowType,
        { foo: 'bar' },
        'user123',
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      resolveInitialSave?.(savedWorkflow);

      const [firstResult, secondResult] = await Promise.all([
        firstCall,
        secondCall,
      ]);

      expect(firstResult.idempotencyKey).toBe(savedWorkflow.idempotencyKey);
      expect(secondResult.id).toBe(savedWorkflow.id);
      expect(executeWorkflowSpy).toHaveBeenCalledTimes(1);
      expect(mockRedisClient.set).toHaveBeenCalledTimes(2);
    });

    it('should trigger compensation when a step exceeds its timeout', async () => {
      const compensateWorkflow = jest.fn().mockResolvedValue(undefined);
      (workflowExecutionService as any).compensationService = {
        compensateWorkflow,
      };

      const workflow = {
        id: 'workflow-timeout',
        idempotencyKey: 'workflow:test:user123:timeout',
        type: 'test_workflow',
        state: WorkflowState.PENDING,
        input: { foo: 'bar' },
        userId: 'user123',
        walletAddress: undefined,
        context: {},
      } as unknown as Workflow;

      const step = {
        id: 'step-timeout',
        workflowId: workflow.id,
        stepName: 'slow_step',
        stepIndex: 0,
        state: StepState.PENDING,
        retryCount: 0,
        maxRetries: 3,
        isIdempotent: true,
      } as WorkflowStep;

      const stepDefinition = {
        name: 'slow_step',
        isIdempotent: true,
        timeout: 5,
        execute: jest
          .fn()
          .mockImplementation(
            () => new Promise((resolve) => setTimeout(resolve, 25)),
          ),
      };

      mockStepRepository.save.mockResolvedValue(step);
      mockWorkflowRepository.save.mockResolvedValue(workflow);

      await expect(
        (workflowExecutionService as any).executeStep(
          workflow,
          step,
          stepDefinition,
        ),
      ).rejects.toThrow('exceeded timeout');

      expect(compensateWorkflow).toHaveBeenCalledWith(workflow.id);
    });
  });

  describe('Monitoring and Metrics', () => {
    it('should determine terminal states correctly', () => {
      const stateMachine = new WorkflowStateMachineService();

      // COMPLETED should be terminal
      expect(stateMachine.isWorkflowTerminal(WorkflowState.COMPLETED)).toBe(
        true,
      );

      // FAILED should not be terminal
      expect(stateMachine.isWorkflowTerminal(WorkflowState.FAILED)).toBe(false);

      // RUNNING should not be terminal
      expect(stateMachine.isWorkflowTerminal(WorkflowState.RUNNING)).toBe(
        false,
      );

      // PENDING should not be terminal
      expect(stateMachine.isWorkflowTerminal(WorkflowState.PENDING)).toBe(
        false,
      );
    });

    it('should determine step terminal states correctly', () => {
      const stateMachine = new WorkflowStateMachineService();

      // COMPLETED should be terminal
      expect(stateMachine.isStepTerminal(StepState.COMPLETED)).toBe(true);

      // SKIPPED should be terminal
      expect(stateMachine.isStepTerminal(StepState.SKIPPED)).toBe(true);

      // COMPENSATED should be terminal
      expect(stateMachine.isStepTerminal(StepState.COMPENSATED)).toBe(true);

      // RUNNING should not be terminal
      expect(stateMachine.isStepTerminal(StepState.RUNNING)).toBe(false);
    });
  });
});
