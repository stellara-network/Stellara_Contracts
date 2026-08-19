import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { QueueService } from '../services/queue.service';

@ApiTags('Queue Admin')
@Controller('admin/queue')
export class QueueAdminController {
  private readonly logger = new Logger(QueueAdminController.name);

  constructor(private readonly queueService: QueueService) {}

  /**
   * Get all queues
   */
  @Get('/')
  @ApiOperation({ summary: 'Get all queue statistics' })
  @ApiResponse({ status: 200, description: 'Queue statistics' })
  async getAllQueueStats() {
    const queues = ['deploy-contract', 'process-tts', 'index-market-news'];
    const stats = await Promise.all(
      queues.map(async (queue) => ({
        queue,
        stats: await this.queueService.getQueueStats(queue),
      })),
    );

    return {
      success: true,
      data: stats,
    };
  }

  /**
   * Get statistics for a specific queue
   */
  @Get('/stats/:queueName')
  @ApiOperation({ summary: 'Get specific queue statistics' })
  @ApiResponse({ status: 200, description: 'Queue statistics' })
  @ApiResponse({ status: 400, description: 'Invalid queue name' })
  async getQueueStats(@Param('queueName') queueName: string) {
    const validQueues = ['deploy-contract', 'process-tts', 'index-market-news'];

    if (!validQueues.includes(queueName)) {
      throw new BadRequestException(
        `Invalid queue name. Valid options: ${validQueues.join(', ')}`,
      );
    }

    const stats = await this.queueService.getQueueStats(queueName);
    return {
      success: true,
      queue: queueName,
      data: stats,
    };
  }

  /**
   * Get all jobs in a queue with optional status filtering
   */
  @Get('/:queueName/jobs')
  @ApiOperation({ summary: 'Get jobs from queue' })
  @ApiResponse({ status: 200, description: 'List of jobs' })
  @ApiResponse({ status: 400, description: 'Invalid queue name' })
  async getQueueJobs(
    @Param('queueName') queueName: string,
    @Query('status') statusQuery?: string,
  ) {
    const validQueues = ['deploy-contract', 'process-tts', 'index-market-news'];

    if (!validQueues.includes(queueName)) {
      throw new BadRequestException(
        `Invalid queue name. Valid options: ${validQueues.join(', ')}`,
      );
    }

    const statuses = statusQuery ? statusQuery.split(',') : undefined;
    const jobs = await this.queueService.getQueueJobs(queueName, statuses);

    return {
      success: true,
      queue: queueName,
      count: jobs.length,
      data: jobs,
    };
  }

  /**
   * Get a specific job by ID
   */
  @Get('/:queueName/jobs/:jobId')
  @ApiOperation({ summary: 'Get job details' })
  @ApiResponse({ status: 200, description: 'Job details' })
  @ApiResponse({ status: 404, description: 'Job not found' })
  @ApiResponse({ status: 400, description: 'Invalid queue name' })
  async getJob(
    @Param('queueName') queueName: string,
    @Param('jobId') jobId: string,
  ) {
    const validQueues = ['deploy-contract', 'process-tts', 'index-market-news'];

    if (!validQueues.includes(queueName)) {
      throw new BadRequestException(
        `Invalid queue name. Valid options: ${validQueues.join(', ')}`,
      );
    }

    const job = await this.queueService.getJobInfo(queueName, jobId);

    if (!job) {
      throw new BadRequestException(
        `Job ${jobId} not found in queue ${queueName}`,
      );
    }

    return {
      success: true,
      data: job,
    };
  }

  /**
   * Get dead-letter queue (failed jobs)
   */
  @Get('/:queueName/dlq')
  @ApiOperation({ summary: 'Get dead-letter queue' })
  @ApiResponse({ status: 200, description: 'Dead-letter queue items' })
  @ApiResponse({ status: 400, description: 'Invalid queue name' })
  async getDeadLetterQueue(
    @Param('queueName') queueName: string,
    @Query('limit') limit: number = 50,
  ) {
    const validQueues = ['deploy-contract', 'process-tts', 'index-market-news'];

    if (!validQueues.includes(queueName)) {
      throw new BadRequestException(
        `Invalid queue name. Valid options: ${validQueues.join(', ')}`,
      );
    }

    const dlqItems = await this.queueService.getDeadLetterQueue(
      queueName,
      limit,
    );

    return {
      success: true,
      queue: queueName,
      count: dlqItems.length,
      data: dlqItems,
    };
  }

  /**
   * Requeue a failed job
   */
  @Post('/:queueName/jobs/:jobId/requeue')
  @ApiOperation({ summary: 'Requeue a failed job' })
  @ApiResponse({ status: 200, description: 'Job requeued successfully' })
  @ApiResponse({ status: 404, description: 'Job not found' })
  @ApiResponse({ status: 400, description: 'Invalid queue name' })
  async requeueJob(
    @Param('queueName') queueName: string,
    @Param('jobId') jobId: string,
  ) {
    const validQueues = ['deploy-contract', 'process-tts', 'index-market-news'];

    if (!validQueues.includes(queueName)) {
      throw new BadRequestException(
        `Invalid queue name. Valid options: ${validQueues.join(', ')}`,
      );
    }

    try {
      const requeuedJob = await this.queueService.requeueJob(queueName, jobId);

      if (!requeuedJob) {
        throw new BadRequestException(`Failed to requeue job ${jobId}`);
      }

      return {
        success: true,
        message: `Job requeued successfully`,
        data: {
          originalJobId: jobId,
          newJobId: requeuedJob.id,
          queue: queueName,
        },
      };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  /**
   * Requeue jobs from dead-letter queue
   */
  @Post('/:queueName/dlq/requeue')
  @ApiOperation({ summary: 'Requeue jobs from dead-letter queue' })
  @ApiResponse({ status: 200, description: 'Jobs requeued successfully' })
  @ApiResponse({ status: 400, description: 'Invalid queue name or error' })
  async requeueFromDLQ(
    @Param('queueName') queueName: string,
    @Query('limit') limit: number = 10,
  ) {
    const validQueues = ['deploy-contract', 'process-tts', 'index-market-news'];

    if (!validQueues.includes(queueName)) {
      throw new BadRequestException(
        `Invalid queue name. Valid options: ${validQueues.join(', ')}`,
      );
    }

    const requeuedJobs = await this.queueService.requeueFromDLQ(
      queueName,
      limit,
    );

    return {
      success: true,
      message: `${requeuedJobs.length} jobs requeued from DLQ`,
      queue: queueName,
      data: {
        requeuedCount: requeuedJobs.length,
        jobIds: requeuedJobs.map((job) => job.id),
      },
    };
  }

  /**
   * Purge queue (remove all jobs)
   */
  @Post('/:queueName/purge')
  @ApiOperation({ summary: 'Purge queue (remove failed jobs)' })
  @ApiResponse({ status: 200, description: 'Queue purged successfully' })
  @ApiResponse({ status: 400, description: 'Invalid queue name' })
  async purgeQueue(@Param('queueName') queueName: string) {
    const validQueues = ['deploy-contract', 'process-tts', 'index-market-news'];

    if (!validQueues.includes(queueName)) {
      throw new BadRequestException(
        `Invalid queue name. Valid options: ${validQueues.join(', ')}`,
      );
    }

    const count = await this.queueService.purgeQueue(queueName);

    return {
      success: true,
      message: `Queue ${queueName} purged`,
      data: {
        purgeCounts: count,
      },
    };
  }
}
