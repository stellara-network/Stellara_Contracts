import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkflowService } from './services/workflow.service';
import { WorkflowExecutionService } from './services/workflow-execution.service';
import { CompensationService } from './services/compensation.service';
import { RecoveryService } from './services/recovery.service';
import { MonitoringService } from './services/monitoring.service';
import { Workflow } from './entities/workflow.entity';
import { WorkflowStep } from './entities/workflow-step.entity';
import { WorkflowState } from './types/workflow-state.enum';

describe('WorkflowService', () => {
  let service: WorkflowService;
  let workflowRepository: Repository<Workflow>;
  let stepRepository: Repository<WorkflowStep>;
  let workflowExecutionService: WorkflowExecutionService;

  const mockWorkflowRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockStepRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockWorkflowExecutionService = {
    startWorkflow: jest.fn(),
    cancelWorkflow: jest.fn(),
    retryWorkflow: jest.fn(),
    compensateWorkflow: jest.fn(),
    registerWorkflowDefinition: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowService,
        {
          provide: getRepositoryToken(Workflow),
          useValue: mockWorkflowRepository,
        },
        {
          provide: getRepositoryToken(WorkflowStep),
          useValue: mockStepRepository,
        },
        {
          provide: WorkflowExecutionService,
          useValue: mockWorkflowExecutionService,
        },
        {
          provide: CompensationService,
          useValue: {
            compensateWorkflow: jest.fn(),
          },
        },
        {
          provide: RecoveryService,
          useValue: {},
        },
        {
          provide: MonitoringService,
          useValue: {},
        },
      ],
    }).compile();

    service = module.get<WorkflowService>(WorkflowService);
    workflowRepository = module.get<Repository<Workflow>>(
      getRepositoryToken(Workflow),
    );
    stepRepository = module.get<Repository<WorkflowStep>>(
      getRepositoryToken(WorkflowStep),
    );
    workflowExecutionService = module.get<WorkflowExecutionService>(
      WorkflowExecutionService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('startWorkflow', () => {
    it('should start a new workflow', async () => {
      const workflowInput = {
        type: 'contract_deployment',
        input: { contractCode: '0x123', contractName: 'TestContract' },
        userId: 'user123',
      };

      const expectedWorkflow = {
        id: 'workflow-id',
        type: 'contract_deployment',
        state: WorkflowState.RUNNING,
      };

      mockWorkflowExecutionService.startWorkflow.mockResolvedValue(
        expectedWorkflow as any,
      );

      const result = await service.startWorkflow(
        workflowInput.type,
        workflowInput.input,
        workflowInput.userId,
      );

      expect(result).toEqual(expectedWorkflow);
      expect(mockWorkflowExecutionService.startWorkflow).toHaveBeenCalledWith(
        workflowInput.type,
        workflowInput.input,
        workflowInput.userId,
        undefined,
        undefined,
      );
    });
  });

  describe('getWorkflow', () => {
    it('should get workflow by ID', async () => {
      const workflowId = 'workflow-id';
      const expectedWorkflow = {
        id: workflowId,
        type: 'contract_deployment',
        state: WorkflowState.RUNNING,
      };

      mockWorkflowRepository.findOne.mockResolvedValue(expectedWorkflow as any);

      const result = await service.getWorkflow(workflowId);

      expect(result).toEqual(expectedWorkflow);
      expect(mockWorkflowRepository.findOne).toHaveBeenCalledWith({
        where: { id: workflowId },
        relations: { steps: true },
      });
    });

    it('should return null for non-existent workflow', async () => {
      mockWorkflowRepository.findOne.mockResolvedValue(null);

      const result = await service.getWorkflow('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('getUserWorkflows', () => {
    it('should get workflows for a user', async () => {
      const userId = 'user123';
      const expectedWorkflows = [
        { id: 'workflow1', userId },
        { id: 'workflow2', userId },
      ];

      mockWorkflowRepository.findAndCount.mockResolvedValue([
        expectedWorkflows,
        2,
      ]);

      const result = await service.getUserWorkflows(userId);

      expect(result).toEqual({ workflows: expectedWorkflows, total: 2 });
      expect(mockWorkflowRepository.findAndCount).toHaveBeenCalledWith({
        where: { userId },
        relations: { steps: true },
        order: { createdAt: 'DESC' },
        skip: 0,
        take: 20,
      });
    });
  });

  describe('getRetryableWorkflows', () => {
    it('should get failed workflows that can be retried', async () => {
      const expectedWorkflows = [
        {
          id: 'workflow1',
          state: WorkflowState.FAILED,
          retryCount: 0,
        },
      ];

      mockWorkflowRepository.find.mockResolvedValue(expectedWorkflows as any);

      const result = await service.getRetryableWorkflows();

      expect(result).toEqual(expectedWorkflows);
      expect(mockWorkflowRepository.find).toHaveBeenCalledWith({
        where: {
          state: WorkflowState.FAILED,
          retryCount: 0,
        },
        relations: { steps: true },
        order: { failedAt: 'DESC' },
      });
    });
  });

  describe('cancelWorkflow', () => {
    it('should cancel a workflow', async () => {
      const workflowId = 'workflow-id';

      await service.cancelWorkflow(workflowId);

      expect(mockWorkflowExecutionService.cancelWorkflow).toHaveBeenCalledWith(
        workflowId,
      );
    });
  });

  describe('retryWorkflow', () => {
    it('should retry a workflow', async () => {
      const workflowId = 'workflow-id';

      await service.retryWorkflow(workflowId);

      expect(mockWorkflowExecutionService.retryWorkflow).toHaveBeenCalledWith(
        workflowId,
      );
    });
  });

  describe('compensateWorkflow', () => {
    it('should compensate a workflow', async () => {
      const workflowId = 'workflow-id';

      const mockCompensationService = {
        compensateWorkflow: jest.fn().mockResolvedValue(undefined),
      };

      // Override the compensation service in the service instance
      (service as any).compensationService = mockCompensationService;

      await service.compensateWorkflow(workflowId);

      expect(mockCompensationService.compensateWorkflow).toHaveBeenCalledWith(
        workflowId,
      );
    });
  });

  // describe('getWorkflowStats', () => {
  //   it('should get workflow statistics', async () => {
  //     const mockWorkflowStats = [
  //       { state: WorkflowState.COMPLETED, count: '10' },
  //       { state: WorkflowState.FAILED, count: '2' },
  //     ];
  //
  //     const mockStepStats = [
  //       { state: 'completed', count: '50' },
  //       { state: 'failed', count: '5' },
  //     ];
  //
  //     const mockQueryBuilder = {
  //       select: jest.fn().mockReturnThis(),
  //       addSelect: jest.fn().mockReturnThis(),
  //       groupBy: jest.fn().mockReturnThis(),
  //       getRawMany: jest.fn()
  //         .mockResolvedValueOnce(mockWorkflowStats)
  //         .mockResolvedValueOnce(mockStepStats),
  //     };
  //
  //     mockWorkflowRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);
  //     mockStepRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);
  //
  //     const result = await service.getWorkflowStats();
  //
  //     expect(result).toEqual({
  //       workflows: {
  //         total: 12,
  //         byState: {
  //           [WorkflowState.COMPLETED]: 10,
  //           [WorkflowState.FAILED]: 2,
  //         },
  //       },
  //       steps: {
  //         total: 55,
  //         byState: {
  //           completed: 50,
  //           failed: 5,
  //         },
  //       },
  //     });
  //   });
  // },

  // describe('searchByIdempotencyKey', () => {
  //   it('should search workflow by idempotency key', async () => {
  //     const idempotencyKey = 'workflow:contract_deployment:user123:abc123';
  //     const expectedWorkflow = {
  //       id: 'workflow-id',
  //       idempotencyKey,
  //     };
  //
  //     mockWorkflowRepository.findOne.mockResolvedValue(expectedWorkflow as any);
  //
  //     const result = await service.searchByIdempotencyKey(idempotencyKey);
  //
  //     expect(result).toEqual(expectedWorkflow);
  //     expect(mockWorkflowRepository.findOne).toHaveBeenCalledWith({
  //       where: { idempotencyKey },
  //       relations: ['steps'],
  //     });
  //   });
  // },

  // describe('getWorkflowExecutionSummary', () => {
  //   it('should get workflow execution summary', async () => {
  //     const workflowId = 'workflow-id';
  //     const mockWorkflow = {
  //       id: workflowId,
  //       type: 'contract_deployment',
  //       state: WorkflowState.COMPLETED,
  //       totalSteps: 4,
  //       currentStepIndex: 3,
  //       createdAt: new Date('2023-01-01'),
  //       startedAt: new Date('2023-01-01T01:00:00'),
  //       completedAt: new Date('2023-01-01T01:05:00'),
  //       retryCount: 1,
  //       maxRetries: 3,
  //       steps: [
  //         { state: 'completed', retryCount: 0 },
  //         { state: 'completed', retryCount: 1 },
  //         { state: 'completed', retryCount: 0 },
  //         { state: 'completed', retryCount: 0 },
  //       ],
  //     };
  //
  //     mockWorkflowRepository.findOne.mockResolvedValue(mockWorkflow as any);
  //
  //     const result = await service.getWorkflowExecutionSummary(workflowId);
  //
  //     expect(result).toEqual({
  //       workflowId,
  //       type: 'contract_deployment',
  //       state: WorkflowState.COMPLETED,
  //       progress: {
  //         totalSteps: 4,
  //         completedSteps: 4,
  //         failedSteps: 0,
  //         runningSteps: 0,
  //         currentStep: 3,
  //         completionPercentage: 100,
  //       },
  //       timing: {
  //         createdAt: mockWorkflow.createdAt,
  //         startedAt: mockWorkflow.startedAt,
  //         completedAt: mockWorkflow.completedAt,
  //         totalExecutionTime: 300000, // 5 minutes
  //         averageStepTime: 75000, // 1.25 minutes
  //       },
  //       retries: {
  //         workflowRetries: 1,
  //         maxRetries: 3,
  //         stepRetries: 1,
  //       },
  //     });
  //   });
  //
  //   it('should throw error for non-existent workflow', async () => {
  //     mockWorkflowRepository.findOne.mockResolvedValue(null);
  //
  //     await expect(service.getWorkflowExecutionSummary('non-existent'))
  //       .rejects.toThrow('Workflow not found');
  //   });
  // },

  describe('cleanupOldWorkflows', () => {
    it('should clean up old workflows', async () => {
      const mockDeleteResult = { affected: 5 };
      mockWorkflowRepository.delete.mockResolvedValue(mockDeleteResult);

      const result = await service.cleanupOldWorkflows(30);

      expect(result).toBe(5);
      expect(mockWorkflowRepository.delete).toHaveBeenCalled();
    });
  });

  describe('processRetryQueue', () => {
    it('should process retry queue', async () => {
      const mockWorkflows = [{ id: 'workflow1' }, { id: 'workflow2' }];

      mockWorkflowRepository.find.mockResolvedValue(mockWorkflows as any);
      mockWorkflowExecutionService.retryWorkflow.mockResolvedValue(undefined);

      const result = await service.processRetryQueue();

      expect(result).toBe(2);
      expect(mockWorkflowExecutionService.retryWorkflow).toHaveBeenCalledTimes(
        2,
      );
      expect(mockWorkflowExecutionService.retryWorkflow).toHaveBeenCalledWith(
        'workflow1',
      );
      expect(mockWorkflowExecutionService.retryWorkflow).toHaveBeenCalledWith(
        'workflow2',
      );
    });
  });
});
