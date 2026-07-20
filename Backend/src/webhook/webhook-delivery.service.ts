import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookDeliveryStatus } from '@prisma/client';
import axios, { AxiosError } from 'axios';
import * as crypto from 'crypto';

export interface StellarEvent {
  id: string;
  eventType: string;
  contractId: string;
  transactionHash: string;
  eventData: any;
  ledgerSeq: number;
  timestamp: Date;
}

export interface WebhookPayload {
  eventId: string;
  eventType: string;
  contractId: string;
  transactionHash: string;
  data: any;
  timestamp: string;
  ledgerSeq: number;
}

@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create delivery records for all matching consumers for a given event
   */
  async createEventDeliveries(event: StellarEvent): Promise<void> {
    try {
      // Find all active consumers that should receive this event
      const matchingConsumers = await this.prisma.webhookConsumer.findMany({
        where: {
          active: true,
          OR: [
            // Consumer wants all events (empty eventTypes array or contains '*')
            { eventTypes: { isEmpty: true } },
            { eventTypes: { has: '*' } },
            // Consumer wants this specific event type
            { eventTypes: { has: event.eventType } },
          ],
          AND: [
            // Consumer wants all contracts (empty contractIds array or contains '*')
            {
              OR: [
                { contractIds: { isEmpty: true } },
                { contractIds: { has: '*' } },
                { contractIds: { has: event.contractId } },
              ],
            },
          ],
        },
      });

      if (matchingConsumers.length === 0) {
        this.logger.debug(`No consumers found for event ${event.id} (${event.eventType})`);
        return;
      }

      // Create delivery records for each matching consumer
      const deliveryPromises = matchingConsumers.map(consumer =>
        this.prisma.webhookEventDelivery.upsert({
          where: {
            eventId_consumerId: {
              eventId: event.id,
              consumerId: consumer.id,
            },
          },
          update: {}, // If already exists, don't change anything
          create: {
            consumerId: consumer.id,
            eventId: event.id,
            eventType: event.eventType,
            contractId: event.contractId,
            transactionHash: event.transactionHash,
            eventData: event.eventData,
            status: WebhookDeliveryStatus.PENDING,
          },
        }),
      );

      await Promise.all(deliveryPromises);

      this.logger.log(
        `Created ${matchingConsumers.length} delivery records for event ${event.id} (${event.eventType})`,
      );

      // Immediately attempt delivery for all pending deliveries
      await this.processPendingDeliveries();
    } catch (error) {
      this.logger.error(`Error creating event deliveries for ${event.id}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Process all pending deliveries (called by scheduler or immediately after creation)
   */
  async processPendingDeliveries(): Promise<void> {
    try {
      // Get deliveries that need processing
      const pendingDeliveries = await this.prisma.webhookEventDelivery.findMany({
        where: {
          OR: [
            { status: WebhookDeliveryStatus.PENDING },
            {
              status: WebhookDeliveryStatus.RETRYING,
              lastAttemptAt: {
                lt: new Date(Date.now() - 30000), // Retry after 30 seconds minimum
              },
            },
          ],
        },
        include: {
          consumer: true,
        },
        orderBy: {
          createdAt: 'asc', // Process older deliveries first
        },
        take: 100, // Process in batches
      });

      if (pendingDeliveries.length === 0) {
        return;
      }

      this.logger.log(`Processing ${pendingDeliveries.length} pending webhook deliveries`);

      // Process deliveries sequentially to avoid overwhelming consumers
      for (const delivery of pendingDeliveries) {
        await this.processDelivery(delivery);
      }
    } catch (error) {
      this.logger.error(`Error processing pending deliveries: ${error.message}`);
    }
  }

  /**
   * Process a single delivery attempt
   */
  private async processDelivery(delivery: any): Promise<void> {
    const { consumer } = delivery;

    // Skip if consumer is inactive
    if (!consumer.active) {
      await this.prisma.webhookEventDelivery.update({
        where: { id: delivery.id },
        data: { status: WebhookDeliveryStatus.DISABLED },
      });
      return;
    }

    // Check if we've exceeded max retries
    if (delivery.attempts >= consumer.maxRetries) {
      await this.prisma.webhookEventDelivery.update({
        where: { id: delivery.id },
        data: {
          status: WebhookDeliveryStatus.FAILED,
          lastError: `Max retries (${consumer.maxRetries}) exceeded`,
        },
      });
      this.logger.error(
        `Delivery ${delivery.id} failed after ${consumer.maxRetries} attempts for consumer ${consumer.name}`,
      );
      return;
    }

    try {
      // Mark as retrying
      await this.prisma.webhookEventDelivery.update({
        where: { id: delivery.id },
        data: {
          status: WebhookDeliveryStatus.RETRYING,
          attempts: delivery.attempts + 1,
          lastAttemptAt: new Date(),
        },
      });

      const startTime = Date.now();
      const response = await this.sendWebhook(delivery, consumer);
      const responseTime = Date.now() - startTime;

      // Success - update delivery record
      await this.prisma.webhookEventDelivery.update({
        where: { id: delivery.id },
        data: {
          status: WebhookDeliveryStatus.DELIVERED,
          deliveredAt: new Date(),
          responseStatus: response.status,
          responseTime,
          responseBody: this.truncateResponse(response.data),
          lastError: null,
        },
      });

      // Update consumer health
      await this.prisma.webhookConsumer.update({
        where: { id: consumer.id },
        data: { lastHealthy: new Date() },
      });

      this.logger.log(
        `Successfully delivered event ${delivery.eventId} to consumer ${consumer.name} (${responseTime}ms)`,
      );
    } catch (error) {
      const errorMessage = this.extractErrorMessage(error);
      const responseStatus = error instanceof AxiosError ? error.response?.status : null;

      await this.prisma.webhookEventDelivery.update({
        where: { id: delivery.id },
        data: {
          status: WebhookDeliveryStatus.PENDING, // Will retry on next run
          lastError: errorMessage,
          responseStatus,
        },
      });

      this.logger.warn(
        `Delivery attempt ${delivery.attempts + 1}/${consumer.maxRetries} failed for event ${delivery.eventId} to consumer ${consumer.name}: ${errorMessage}`,
      );

      // Add exponential backoff delay for retries
      if (delivery.attempts + 1 < consumer.maxRetries) {
        const delayMs = consumer.retryDelayMs * Math.pow(2, delivery.attempts);
        this.logger.debug(`Next retry for delivery ${delivery.id} in ${delayMs}ms`);
      }
    }
  }

  /**
   * Send webhook HTTP request to consumer
   */
  private async sendWebhook(delivery: any, consumer: any): Promise<any> {
    const payload: WebhookPayload = {
      eventId: delivery.eventId,
      eventType: delivery.eventType,
      contractId: delivery.contractId,
      transactionHash: delivery.transactionHash,
      data: delivery.eventData,
      timestamp: delivery.createdAt.toISOString(),
      ledgerSeq: delivery.eventData.ledgerSeq || 0,
    };

    const headers: any = {
      'Content-Type': 'application/json',
      'User-Agent': 'Stellara-Webhook-Delivery/1.0',
      'X-Stellara-Event-Id': delivery.eventId,
      'X-Stellara-Event-Type': delivery.eventType,
      'X-Stellara-Delivery-Attempt': delivery.attempts + 1,
    };

    // Add HMAC signature if consumer has a secret
    if (consumer.secret) {
      const signature = this.generateSignature(JSON.stringify(payload), consumer.secret);
      headers['X-Stellara-Signature'] = signature;
    }

    const response = await axios.post(consumer.url, payload, {
      headers,
      timeout: consumer.timeout,
      validateStatus: (status) => status >= 200 && status < 300, // Only 2xx are success
    });

    return response;
  }

  /**
   * Generate HMAC signature for webhook verification
   */
  private generateSignature(payload: string, secret: string): string {
    return `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
  }

  /**
   * Truncate response body to prevent storing large responses
   */
  private truncateResponse(data: any): string {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    return str.length > 1000 ? str.substring(0, 1000) + '...' : str;
  }

  /**
   * Extract meaningful error message from various error types
   */
  private extractErrorMessage(error: any): string {
    if (error instanceof AxiosError) {
      if (error.response) {
        return `HTTP ${error.response.status}: ${error.response.statusText}`;
      }
      if (error.request) {
        return `Network error: ${error.code || 'UNKNOWN'}`;
      }
    }
    return error.message || 'Unknown error';
  }

  /**
   * Get delivery statistics for a consumer
   */
  async getConsumerStats(consumerId: string): Promise<{
    total: number;
    pending: number;
    delivered: number;
    failed: number;
    retrying: number;
    successRate: number;
  }> {
    const stats = await this.prisma.webhookEventDelivery.groupBy({
      by: ['status'],
      where: { consumerId },
      _count: { status: true },
    });

    const statusCounts = stats.reduce(
      (acc, stat) => {
        acc[stat.status] = stat._count.status;
        return acc;
      },
      {
        PENDING: 0,
        DELIVERED: 0,
        FAILED: 0,
        RETRYING: 0,
        DISABLED: 0,
      },
    );

    const total = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);
    const successful = statusCounts.DELIVERED;
    const successRate = total > 0 ? (successful / total) * 100 : 0;

    return {
      total,
      pending: statusCounts.PENDING,
      delivered: statusCounts.DELIVERED,
      failed: statusCounts.FAILED,
      retrying: statusCounts.RETRYING,
      successRate: Math.round(successRate * 100) / 100,
    };
  }

  /**
   * Retry failed deliveries for a specific consumer
   */
  async retryFailedDeliveries(consumerId: string): Promise<number> {
    const failedDeliveries = await this.prisma.webhookEventDelivery.updateMany({
      where: {
        consumerId,
        status: WebhookDeliveryStatus.FAILED,
      },
      data: {
        status: WebhookDeliveryStatus.PENDING,
        attempts: 0,
        lastError: null,
      },
    });

    this.logger.log(`Reset ${failedDeliveries.count} failed deliveries for consumer ${consumerId}`);
    return failedDeliveries.count;
  }

  /**
   * Clean up old delivery records
   */
  async cleanupOldDeliveries(olderThanDays: number = 30): Promise<number> {
    const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

    const deleted = await this.prisma.webhookEventDelivery.deleteMany({
      where: {
        createdAt: { lt: cutoffDate },
        status: { in: [WebhookDeliveryStatus.DELIVERED, WebhookDeliveryStatus.FAILED] },
      },
    });

    this.logger.log(`Cleaned up ${deleted.count} old webhook delivery records`);
    return deleted.count;
  }
}