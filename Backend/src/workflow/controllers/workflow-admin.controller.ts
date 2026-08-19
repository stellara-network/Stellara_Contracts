import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import { Workflow } from '../entities/workflow.entity';
import { WorkflowStep } from '../entities/workflow-step.entity';
import { WorkflowState } from '../types/workflow-state.enum';
import { StepState } from '../types/step-state.enum';
import { WorkflowExecutionService } from '../services/workflow-execution.service';
import { CompensationService } from '../services/compensation.service';
import { RecoveryService } from '../services/recovery.service';
import { MonitoringService } from '../services/monitoring.service';
import {
  WorkflowNotFoundError,
  WorkflowInvalidStateError,
  StepNotFoundError,
  StepInvalidStateError,
  ApiError,
  ApiErrorCode,
} from '../../common/exceptions/api-error.exception';
import { HttpStatus } from '@nestjs/common';

@ApiTags('workflow-admin')
@Controller('admin/workflows')
export class WorkflowAdminController {
  constructor(
    @InjectRepository(Workflow)
    private readonly workflowRepository: Repository<Workflow>,
    @InjectRepository(WorkflowStep)
    private readonly stepRepository: Repository<WorkflowStep>,
    private readonly workflowExecutionService: WorkflowExecutionService,
    private readonly compensationService: CompensationService,
    private readonly recoveryService: RecoveryService,
    private readonly monitoringService: MonitoringService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get all workflows with pagination and filtering' })
  @ApiResponse({ status: 200, description: 'List of workflows' })
  async getWorkflows(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 20,
    @Query('state') state?: WorkflowState,
    @Query('type') type?: string,
    @Query('userId') userId?: string,
    @Query('walletAddress') walletAddress?: string,
  ) {
    const skip = (page - 1) * limit;
    const where: any = {};

    if (state) where.state = state;
    if (type) where.type = type;
    if (userId) where.userId = userId;
    if (walletAddress) where.walletAddress = walletAddress;

    const [workflows, total] = await this.workflowRepository.findAndCount({
      where,
      relations: { steps: true },
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return {
      workflows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get workflow by ID' })
  @ApiParam({ name: 'id', description: 'Workflow ID' })
  @ApiResponse({ status: 200, description: 'Workflow details' })
  @ApiResponse({
    status: 404,
    description: 'Workflow not found',
    schema: {
      properties: {
        success: { type: 'boolean', example: false },
        statusCode: { type: 'number', example: 404 },
        errorCode: { type: 'string', example: 'WORKFLOW_NOT_FOUND' },
        message: { type: 'string', example: "Workflow '123' not found" },
        timestamp: { type: 'string', format: 'date-time' },
        path: { type: 'string' },
      },
    },
  })
  async getWorkflow(@Param('id') id: string) {
    const workflow = await this.workflowRepository.findOne({
      where: { id },
      relations: { steps: true },
    });

    if (!workflow) {
      throw new WorkflowNotFoundError(id);
    }

    return workflow;
  }

  @Get(':id/timeline')
  @ApiOperation({ summary: 'Get workflow execution timeline' })
  @ApiParam({ name: 'id', description: 'Workflow ID' })
  @ApiResponse({ status: 200, description: 'Workflow timeline' })
  @ApiResponse({ status: 404, description: 'Workflow not found' })
  async getWorkflowTimeline(@Param('id') id: string) {
    const workflow = await this.workflowRepository.findOne({
      where: { id },
      relations: { steps: true },
    });

    if (!workflow) {
      throw new WorkflowNotFoundError(id);
    }

    const timeline: any[] = [
      {
        type: 'workflow_created',
        timestamp: workflow.createdAt,
        state: workflow.state,
        message: 'Workflow created',
      },
    ];

    if (workflow.startedAt) {
      timeline.push({
        type: 'workflow_started',
        timestamp: workflow.startedAt,
        state: workflow.state,
        message: 'Workflow execution started',
      });
    }

    // Add step events
    workflow.steps.forEach((step) => {
      if (step.startedAt) {
        timeline.push({
          type: 'step_started',
          timestamp: step.startedAt,
          stepName: step.stepName,
          stepIndex: step.stepIndex,
          state: step.state,
          message: `Step "${step.stepName}" started`,
        });
      }

      if (step.completedAt) {
        timeline.push({
          type: 'step_completed',
          timestamp: step.completedAt,
          stepName: step.stepName,
          stepIndex: step.stepIndex,
          state: step.state,
          message: `Step "${step.stepName}" completed`,
        });
      }

      if (step.failedAt) {
        timeline.push({
          type: 'step_failed',
          timestamp: step.failedAt,
          stepName: step.stepName,
          stepIndex: step.stepIndex,
          state: step.state,
          failureReason: step.failureReason,
          retryCount: step.retryCount,
          message: `Step "${step.stepName}" failed: ${step.failureReason}`,
        });
      }

      if (step.compensatedAt) {
        timeline.push({
          type: 'step_compensated',
          timestamp: step.compensatedAt,
          stepName: step.stepName,
          stepIndex: step.stepIndex,
          state: step.state,
          message: `Step "${step.stepName}" compensated`,
        });
      }
    });

    if (workflow.completedAt) {
      timeline.push({
        type: 'workflow_completed',
        timestamp: workflow.completedAt,
        state: workflow.state,
        message: 'Workflow completed successfully',
      });
    }

    if (workflow.failedAt) {
      timeline.push({
        type: 'workflow_failed',
        timestamp: workflow.failedAt,
        state: workflow.state,
        failureReason: workflow.failureReason,
        retryCount: workflow.retryCount,
        message: `Workflow failed: ${workflow.failureReason}`,
      });
    }

    return {
      workflowId: workflow.id,
      timeline: timeline.sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
      ),
    };
  }

  @Post(':id/retry')
  @ApiOperation({ summary: 'Retry a failed workflow' })
  @ApiParam({ name: 'id', description: 'Workflow ID' })
  @ApiResponse({ status: 200, description: 'Workflow retry initiated' })
  @ApiResponse({
    status: 400,
    description: 'Workflow cannot be retried',
    schema: {
      properties: {
        success: { type: 'boolean', example: false },
        statusCode: { type: 'number', example: 400 },
        errorCode: { type: 'string', example: 'WORKFLOW_INVALID_STATE' },
        message: {
          type: 'string',
          example: 'Workflow is not in a failed state',
        },
        timestamp: { type: 'string', format: 'date-time' },
        path: { type: 'string' },
      },
    },
  })
  async retryWorkflow(@Param('id') id: string) {
    try {
      await this.workflowExecutionService.retryWorkflow(id);
      return { message: 'Workflow retry initiated', workflowId: id };
    } catch (error) {
      // Re-throw ApiErrors directly; wrap plain errors as domain errors
      if (error instanceof ApiError) throw error;
      throw new WorkflowInvalidStateError(error.message);
    }
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel a workflow' })
  @ApiParam({ name: 'id', description: 'Workflow ID' })
  @ApiResponse({ status: 200, description: 'Workflow cancelled' })
  @ApiResponse({
    status: 400,
    description: 'Workflow cannot be cancelled',
    schema: {
      properties: {
        success: { type: 'boolean', example: false },
        statusCode: { type: 'number', example: 400 },
        errorCode: { type: 'string', example: 'WORKFLOW_INVALID_STATE' },
        message: {
          type: 'string',
          example: 'Workflow cannot be cancelled in its current state',
        },
        timestamp: { type: 'string', format: 'date-time' },
        path: { type: 'string' },
      },
    },
  })
  async cancelWorkflow(@Param('id') id: string) {
    try {
      await this.workflowExecutionService.cancelWorkflow(id);
      return { message: 'Workflow cancelled', workflowId: id };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new WorkflowInvalidStateError(error.message);
    }
  }

  @Post(':id/compensate')
  @ApiOperation({ summary: 'Compensate a workflow' })
  @ApiParam({ name: 'id', description: 'Workflow ID' })
  @ApiResponse({ status: 200, description: 'Workflow compensation initiated' })
  @ApiResponse({
    status: 400,
    description: 'Workflow cannot be compensated',
    schema: {
      properties: {
        success: { type: 'boolean', example: false },
        statusCode: { type: 'number', example: 400 },
        errorCode: { type: 'string', example: 'COMPENSATION_FAILED' },
        message: { type: 'string', example: 'Compensation failed' },
        timestamp: { type: 'string', format: 'date-time' },
        path: { type: 'string' },
      },
    },
  })
  async compensateWorkflow(@Param('id') id: string) {
    try {
      await this.compensationService.compensateWorkflow(id);
      return { message: 'Workflow compensation initiated', workflowId: id };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        ApiErrorCode.COMPENSATION_FAILED,
        error.message,
      );
    }
  }

  @Get(':id/steps/:stepId')
  @ApiOperation({ summary: 'Get specific step details' })
  @ApiParam({ name: 'id', description: 'Workflow ID' })
  @ApiParam({ name: 'stepId', description: 'Step ID' })
  @ApiResponse({ status: 200, description: 'Step details' })
  @ApiResponse({
    status: 404,
    description: 'Step not found',
    schema: {
      properties: {
        success: { type: 'boolean', example: false },
        statusCode: { type: 'number', example: 404 },
        errorCode: { type: 'string', example: 'STEP_NOT_FOUND' },
        message: { type: 'string', example: "Step 'abc' not found" },
        timestamp: { type: 'string', format: 'date-time' },
        path: { type: 'string' },
      },
    },
  })
  async getWorkflowStep(
    @Param('id') workflowId: string,
    @Param('stepId') stepId: string,
  ) {
    const step = await this.stepRepository.findOne({
      where: { id: stepId, workflowId },
    });

    if (!step) {
      throw new StepNotFoundError(stepId);
    }

    return step;
  }

  @Post(':id/steps/:stepId/retry')
  @ApiOperation({ summary: 'Retry a specific step' })
  @ApiParam({ name: 'id', description: 'Workflow ID' })
  @ApiParam({ name: 'stepId', description: 'Step ID' })
  @ApiResponse({ status: 200, description: 'Step retry initiated' })
  @ApiResponse({ status: 400, description: 'Step cannot be retried' })
  @ApiResponse({ status: 404, description: 'Step not found' })
  async retryWorkflowStep(
    @Param('id') workflowId: string,
    @Param('stepId') stepId: string,
  ) {
    const step = await this.stepRepository.findOne({
      where: { id: stepId, workflowId },
    });

    if (!step) {
      throw new StepNotFoundError(stepId);
    }

    if (step.state !== StepState.FAILED) {
      throw new StepInvalidStateError('Step is not in a failed state');
    }

    // Reset step state
    step.state = StepState.PENDING;
    step.failedAt = undefined;
    step.failureReason = undefined;
    step.retryCount += 1;
    await this.stepRepository.save(step);

    // Retry the entire workflow from this step
    await this.workflowExecutionService.retryWorkflow(workflowId);

    return { message: 'Step retry initiated', stepId, workflowId };
  }

  @Get('stats/overview')
  @ApiOperation({ summary: 'Get workflow statistics overview' })
  @ApiResponse({ status: 200, description: 'Workflow statistics' })
  async getWorkflowStats() {
    const stats = await this.workflowRepository
      .createQueryBuilder('workflow')
      .select('workflow.state', 'state')
      .addSelect('COUNT(*)', 'count')
      .groupBy('workflow.state')
      .getRawMany();

    const totalWorkflows = stats.reduce(
      (sum, stat) => sum + parseInt(stat.count),
      0,
    );
    const stateStats = stats.reduce((acc, stat) => {
      acc[stat.state] = parseInt(stat.count);
      return acc;
    }, {});

    // Get step stats
    const stepStats = await this.stepRepository
      .createQueryBuilder('step')
      .select('step.state', 'state')
      .addSelect('COUNT(*)', 'count')
      .groupBy('step.state')
      .getRawMany();

    const totalSteps = stepStats.reduce(
      (sum, stat) => sum + parseInt(stat.count),
      0,
    );
    const stepStateStats = stepStats.reduce((acc, stat) => {
      acc[stat.state] = parseInt(stat.count);
      return acc;
    }, {});

    return {
      workflows: {
        total: totalWorkflows,
        byState: stateStats,
      },
      steps: {
        total: totalSteps,
        byState: stepStateStats,
      },
    };
  }

  @Get('search')
  @ApiOperation({ summary: 'Search workflows by idempotency key or metadata' })
  @ApiResponse({ status: 200, description: 'Search results' })
  async searchWorkflows(
    @Query('q') query: string,
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 20,
  ) {
    const skip = (page - 1) * limit;

    const [workflows, total] = await this.workflowRepository.findAndCount({
      where: [
        { idempotencyKey: Like(`%${query}%`) },
        { walletAddress: Like(`%${query}%`) },
      ],
      relations: { steps: true },
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return {
      workflows,
      query,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  @Post('recovery/trigger')
  @ApiOperation({ summary: 'Trigger manual recovery process' })
  @ApiResponse({ status: 200, description: 'Recovery process initiated' })
  @ApiResponse({
    status: 500,
    description: 'Recovery process failed',
    schema: {
      properties: {
        success: { type: 'boolean', example: false },
        statusCode: { type: 'number', example: 500 },
        errorCode: { type: 'string', example: 'RECOVERY_FAILED' },
        message: { type: 'string' },
        timestamp: { type: 'string', format: 'date-time' },
        path: { type: 'string' },
      },
    },
  })
  async triggerRecovery() {
    try {
      const results = await this.recoveryService.triggerManualRecovery();
      return {
        message: 'Recovery process completed',
        results,
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        ApiErrorCode.RECOVERY_FAILED,
        error.message,
      );
    }
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Get workflow metrics and statistics' })
  @ApiResponse({ status: 200, description: 'Workflow metrics' })
  async getMetrics(@Query('hours') hours: number = 24) {
    try {
      const workflowMetrics =
        await this.monitoringService.getWorkflowMetrics(hours);
      const stepMetrics = await this.monitoringService.getStepMetrics(hours);
      const systemHealth = await this.monitoringService.getSystemHealth();

      return {
        workflowMetrics,
        stepMetrics,
        systemHealth,
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        ApiErrorCode.INTERNAL_SERVER_ERROR,
        error.message,
      );
    }
  }

  @Get('health')
  @ApiOperation({ summary: 'Get workflow engine health status' })
  @ApiResponse({ status: 200, description: 'Health status' })
  async getHealth() {
    try {
      const health = await this.monitoringService.getSystemHealth();
      return health;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        ApiErrorCode.INTERNAL_SERVER_ERROR,
        error.message,
      );
    }
  }

  @Get('compensatable')
  @ApiOperation({ summary: 'Get workflows that require compensation' })
  @ApiResponse({ status: 200, description: 'Compensatable workflows' })
  async getCompensatableWorkflows() {
    try {
      const workflows =
        await this.compensationService.getCompensatableWorkflows();
      return { workflows };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        ApiErrorCode.INTERNAL_SERVER_ERROR,
        error.message,
      );
    }
  }

  @Post(':id/force-compensate')
  @ApiOperation({ summary: 'Force compensate a workflow (admin only)' })
  @ApiParam({ name: 'id', description: 'Workflow ID' })
  @ApiResponse({ status: 200, description: 'Force compensation initiated' })
  @ApiResponse({
    status: 400,
    description: 'Force compensation failed',
    schema: {
      properties: {
        success: { type: 'boolean', example: false },
        statusCode: { type: 'number', example: 400 },
        errorCode: { type: 'string', example: 'COMPENSATION_FAILED' },
        message: { type: 'string' },
        timestamp: { type: 'string', format: 'date-time' },
        path: { type: 'string' },
      },
    },
  })
  async forceCompensateWorkflow(@Param('id') id: string) {
    try {
      await this.compensationService.forceCompensateWorkflow(id);
      return { message: 'Force compensation completed', workflowId: id };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        ApiErrorCode.COMPENSATION_FAILED,
        error.message,
      );
    }
  }
}
