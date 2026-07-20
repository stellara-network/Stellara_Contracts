import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookDeliveryStatus } from '@prisma/client';

@Injectable()
export class WebhookRetryTask {
  private readonly logger = new Logger(WebhookRetryTask.name);
  private isProcessing = false;

  constructor(
    private readonly webhookDeliveryService: WebhookDeliveryService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Process pending webhook deliveries every minute
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async handleWebhookRetries() {
    if (this.isProcessing) {
      this.logger.debug('Webhook retry task already running, skipping...');
      return;
    }

    this.isProcessing = true;

    try {
      this.logger.debug('Starting webhook delivery retry task...');
      await this.webhookDeliveryService.processPendingDeliveries();
    } catch (error) {
      this.logger.error(`Error in webhook retry task: ${error.message}`);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Generate health report for webhook consumers every 5 minutes
   */
  @Cron('*/5 * * * *') // Every 5 minutes
  async generateHealthReport() {
    try {
      const consumers = await this.prisma.webhookConsumer.findMany({
        where: { active: true },
      });

      for (const consumer of consumers) {
        const stats = await this.webhookDeliveryService.getConsumerStats(consumer.id);
        
        // Log warning if success rate is below 90%
        if (stats.successRate < 90 && stats.total > 10) {
          this.logger.warn(
            `Consumer '${consumer.name}' has low success rate: ${stats.successRate}% (${stats.delivered}/${stats.total})`,
          );
        }

        // Log error if consumer hasn't been healthy for more than 1 hour
        if (consumer.lastHealthy) {
          const hoursSinceHealthy = (Date.now() - consumer.lastHealthy.getTime()) / (1000 * 60 * 60);
          if (hoursSinceHealthy > 1) {
            this.logger.error(
              `Consumer '${consumer.name}' hasn't been healthy for ${Math.round(hoursSinceHealthy)} hours`,
            );
          }
        }
      }
    } catch (error) {
      this.logger.error(`Error generating webhook health report: ${error.message}`);
    }
  }

  /**
   * Clean up old delivery records daily at 2 AM
   */
  @Cron('0 2 * * *')
  async cleanupOldDeliveries() {
    try {
      this.logger.log('Starting cleanup of old webhook delivery records...');
      const deleted = await this.webhookDeliveryService.cleanupOldDeliveries(30); // Keep 30 days
      this.logger.log(`Cleaned up ${deleted} old webhook delivery records`);
    } catch (error) {
      this.logger.error(`Error during webhook delivery cleanup: ${error.message}`);
    }
  }

  /**
   * Reset stuck deliveries every hour
   * Sometimes deliveries can get stuck in RETRYING status due to crashes or other issues
   */
  @Cron(CronExpression.EVERY_HOUR)
  async resetStuckDeliveries() {
    try {
      const stuckCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago

      const stuckDeliveries = await this.prisma.webhookEventDelivery.updateMany({
        where: {
          status: WebhookDeliveryStatus.RETRYING,
          lastAttemptAt: {
            lt: stuckCutoff,
          },
        },
        data: {
          status: WebhookDeliveryStatus.PENDING,
        },
      });

      if (stuckDeliveries.count > 0) {
        this.logger.log(`Reset ${stuckDeliveries.count} stuck webhook deliveries`);
      }
    } catch (error) {
      this.logger.error(`Error resetting stuck deliveries: ${error.message}`);
    }
  }

  /**
   * Daily summary report at 9 AM
   */
  @Cron('0 9 * * *')
  async generateDailySummary() {
    try {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      
      // Get yesterday's delivery stats
      const yesterdayStats = await this.prisma.webhookEventDelivery.groupBy({
        by: ['status'],
        where: {
          createdAt: {
            gte: yesterday,
          },
        },
        _count: { status: true },
      });

      const statusCounts = yesterdayStats.reduce(
        (acc, stat) => {
          acc[stat.status] = stat._count.status;
          return acc;
        },
        { DELIVERED: 0, FAILED: 0, PENDING: 0, RETRYING: 0, DISABLED: 0 },
      );

      const total = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);
      const successRate = total > 0 ? (statusCounts.DELIVERED / total) * 100 : 0;

      this.logger.log(
        `Daily webhook summary: ${total} deliveries, ${Math.round(successRate)}% success rate ` +
        `(${statusCounts.DELIVERED} delivered, ${statusCounts.FAILED} failed, ${statusCounts.PENDING + statusCounts.RETRYING} pending)`,
      );

      // Get top failing consumers
      const failingConsumers = await this.prisma.webhookEventDelivery.groupBy({
        by: ['consumerId'],
        where: {
          status: WebhookDeliveryStatus.FAILED,
          createdAt: {
            gte: yesterday,
          },
        },
        _count: { consumerId: true },
        orderBy: {
          _count: {
            consumerId: 'desc',
          },
        },
        take: 5,
      });

      if (failingConsumers.length > 0) {
        for (const consumer of failingConsumers) {
          const consumerDetails = await this.prisma.webhookConsumer.findUnique({
            where: { id: consumer.consumerId },
            select: { name: true },
          });

          this.logger.warn(
            `Consumer '${consumerDetails?.name}' had ${consumer._count.consumerId} failed deliveries yesterday`,
          );
        }
      }
    } catch (error) {
      this.logger.error(`Error generating daily summary: ${error.message}`);
    }
  }
}