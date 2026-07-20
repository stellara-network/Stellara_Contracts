import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpStatus,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { EventStorageService } from './event-storage.service';

export interface CreateWebhookConsumerDto {
  name: string;
  url: string;
  secret?: string;
  eventTypes?: string[];
  contractIds?: string[];
  maxRetries?: number;
  retryDelayMs?: number;
  timeout?: number;
  description?: string;
  tags?: any;
}

export interface UpdateWebhookConsumerDto {
  name?: string;
  url?: string;
  secret?: string;
  eventTypes?: string[];
  contractIds?: string[];
  maxRetries?: number;
  retryDelayMs?: number;
  timeout?: number;
  description?: string;
  tags?: any;
  active?: boolean;
}

@Controller('webhooks')
export class WebhookController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webhookDeliveryService: WebhookDeliveryService,
    private readonly eventStorageService: EventStorageService,
  ) {}

  /**
   * Create a new webhook consumer
   */
  @Post('consumers')
  async createConsumer(@Body() dto: CreateWebhookConsumerDto) {
    // Validate URL format
    try {
      new URL(dto.url);
    } catch {
      throw new BadRequestException('Invalid URL format');
    }

    const consumer = await this.prisma.webhookConsumer.create({
      data: {
        name: dto.name,
        url: dto.url,
        secret: dto.secret,
        eventTypes: dto.eventTypes || [],
        contractIds: dto.contractIds || [],
        maxRetries: dto.maxRetries || 3,
        retryDelayMs: dto.retryDelayMs || 5000,
        timeout: dto.timeout || 30000,
        description: dto.description,
        tags: dto.tags,
      },
    });

    return {
      status: HttpStatus.CREATED,
      data: consumer,
    };
  }

  /**
   * List all webhook consumers
   */
  @Get('consumers')
  async listConsumers(@Query('active') active?: string) {
    const whereClause = active !== undefined ? { active: active === 'true' } : {};

    const consumers = await this.prisma.webhookConsumer.findMany({
      where: whereClause,
      include: {
        _count: {
          select: {
            deliveries: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Get stats for each consumer
    const consumersWithStats = await Promise.all(
      consumers.map(async consumer => {
        const stats = await this.webhookDeliveryService.getConsumerStats(consumer.id);
        return {
          ...consumer,
          stats,
        };
      }),
    );

    return {
      status: HttpStatus.OK,
      data: consumersWithStats,
    };
  }

  /**
   * Get a specific webhook consumer
   */
  @Get('consumers/:id')
  async getConsumer(@Param('id') id: string) {
    const consumer = await this.prisma.webhookConsumer.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            deliveries: true,
          },
        },
      },
    });

    if (!consumer) {
      throw new NotFoundException('Webhook consumer not found');
    }

    const stats = await this.webhookDeliveryService.getConsumerStats(id);

    return {
      status: HttpStatus.OK,
      data: {
        ...consumer,
        stats,
      },
    };
  }

  /**
   * Update a webhook consumer
   */
  @Put('consumers/:id')
  async updateConsumer(@Param('id') id: string, @Body() dto: UpdateWebhookConsumerDto) {
    // Validate URL format if provided
    if (dto.url) {
      try {
        new URL(dto.url);
      } catch {
        throw new BadRequestException('Invalid URL format');
      }
    }

    const consumer = await this.prisma.webhookConsumer.update({
      where: { id },
      data: dto,
    });

    return {
      status: HttpStatus.OK,
      data: consumer,
    };
  }

  /**
   * Delete a webhook consumer
   */
  @Delete('consumers/:id')
  async deleteConsumer(@Param('id') id: string) {
    await this.prisma.webhookConsumer.delete({
      where: { id },
    });

    return {
      status: HttpStatus.OK,
      message: 'Webhook consumer deleted successfully',
    };
  }

  /**
   * Get delivery history for a consumer
   */
  @Get('consumers/:id/deliveries')
  async getConsumerDeliveries(
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const whereClause: any = { consumerId: id };
    if (status) {
      whereClause.status = status;
    }

    const deliveries = await this.prisma.webhookEventDelivery.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit || '50'),
      skip: parseInt(offset || '0'),
      select: {
        id: true,
        eventId: true,
        eventType: true,
        contractId: true,
        transactionHash: true,
        status: true,
        attempts: true,
        lastAttemptAt: true,
        lastError: true,
        responseStatus: true,
        responseTime: true,
        createdAt: true,
        deliveredAt: true,
      },
    });

    return {
      status: HttpStatus.OK,
      data: deliveries,
    };
  }

  /**
   * Retry failed deliveries for a consumer
   */
  @Post('consumers/:id/retry')
  async retryConsumerDeliveries(@Param('id') id: string) {
    const retryCount = await this.webhookDeliveryService.retryFailedDeliveries(id);

    return {
      status: HttpStatus.OK,
      message: `Reset ${retryCount} failed deliveries for retry`,
      data: { retryCount },
    };
  }

  /**
   * Test a webhook consumer by sending a test payload
   */
  @Post('consumers/:id/test')
  async testConsumer(@Param('id') id: string, @Body() testPayload?: any) {
    const consumer = await this.prisma.webhookConsumer.findUnique({
      where: { id },
    });

    if (!consumer) {
      throw new NotFoundException('Webhook consumer not found');
    }

    // Create a test event
    const testEvent = {
      id: `test-${Date.now()}`,
      eventType: 'test_event',
      contractId: 'test_contract',
      transactionHash: 'test_tx_hash',
      eventData: testPayload || { message: 'Test webhook delivery', timestamp: new Date().toISOString() },
      ledgerSeq: 0,
      timestamp: new Date(),
    };

    try {
      // Create a temporary delivery record
      const delivery = await this.prisma.webhookEventDelivery.create({
        data: {
          consumerId: consumer.id,
          eventId: testEvent.id,
          eventType: testEvent.eventType,
          contractId: testEvent.contractId,
          transactionHash: testEvent.transactionHash,
          eventData: testEvent.eventData,
        },
        include: {
          consumer: true,
        },
      });

      // Process the test delivery
      await this.webhookDeliveryService.processPendingDeliveries();

      // Get the result
      const result = await this.prisma.webhookEventDelivery.findUnique({
        where: { id: delivery.id },
      });

      return {
        status: HttpStatus.OK,
        data: {
          deliveryStatus: result?.status,
          attempts: result?.attempts,
          responseStatus: result?.responseStatus,
          responseTime: result?.responseTime,
          lastError: result?.lastError,
        },
      };
    } catch (error) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Test delivery failed',
        error: error.message,
      };
    }
  }

  /**
   * Get event delivery status
   */
  @Get('events/:eventId/deliveries')
  async getEventDeliveries(@Param('eventId') eventId: string) {
    try {
      const deliveryStatus = await this.eventStorageService.getEventDeliveryStatus(eventId);
      
      return {
        status: HttpStatus.OK,
        data: deliveryStatus,
      };
    } catch (error) {
      if (error.message.includes('not found')) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  /**
   * Reprocess an event for specific consumers
   */
  @Post('events/:eventId/reprocess')
  async reprocessEvent(
    @Param('eventId') eventId: string,
    @Body() body: { consumerIds?: string[] },
  ) {
    const result = await this.eventStorageService.reprocessEventForConsumers(
      eventId,
      body.consumerIds,
    );

    return {
      status: HttpStatus.OK,
      message: `Reprocessed ${result.reprocessed} deliveries`,
      data: result,
    };
  }

  /**
   * Get global webhook delivery statistics
   */
  @Get('stats')
  async getGlobalStats() {
    const stats = await this.eventStorageService.getGlobalDeliveryStats();

    return {
      status: HttpStatus.OK,
      data: stats,
    };
  }

  /**
   * Get events with failed deliveries
   */
  @Get('failures')
  async getEventsWithFailures(@Query('limit') limit?: string) {
    const events = await this.eventStorageService.getEventsWithFailures(
      parseInt(limit || '50'),
    );

    return {
      status: HttpStatus.OK,
      data: events,
    };
  }
}