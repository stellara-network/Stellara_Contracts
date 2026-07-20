import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookDeliveryService, StellarEvent } from './webhook-delivery.service';

export interface StoredEvent {
  id: string;
  eventId: string;
  eventType: string;
  contractId: string;
  transactionHash: string;
  eventData: any;
  ledgerSeq: number;
  processedAt: Date;
  deliveryAttempts: number; // DEPRECATED - use per-consumer delivery tracking instead
}

@Injectable()
export class EventStorageService {
  private readonly logger = new Logger(EventStorageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhookDeliveryService: WebhookDeliveryService,
  ) {}

  /**
   * Store an event and create delivery records for all matching consumers
   */
  async storeEvent(event: StellarEvent): Promise<StoredEvent> {
    try {
      // Store the event in ProcessedEvent table
      const storedEvent = await this.prisma.processedEvent.upsert({
        where: { eventId: event.id },
        update: {
          // Update existing record if needed
          processedAt: new Date(),
        },
        create: {
          eventId: event.id,
          network: 'mainnet', // or determine from config
          ledgerSeq: event.ledgerSeq,
          contractId: event.contractId,
          eventType: event.eventType,
          transactionHash: event.transactionHash,
          processedAt: new Date(),
        },
      });

      // Create webhook delivery records for all matching consumers
      await this.webhookDeliveryService.createEventDeliveries(event);

      this.logger.log(
        `Stored event ${event.id} (${event.eventType}) and created webhook delivery records`,
      );

      return {
        id: storedEvent.id,
        eventId: storedEvent.eventId,
        eventType: storedEvent.eventType,
        contractId: storedEvent.contractId,
        transactionHash: storedEvent.transactionHash,
        eventData: event.eventData,
        ledgerSeq: storedEvent.ledgerSeq,
        processedAt: storedEvent.processedAt,
        deliveryAttempts: 0, // Deprecated field - now tracked per consumer
      };
    } catch (error) {
      this.logger.error(`Error storing event ${event.id}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get event delivery status across all consumers
   */
  async getEventDeliveryStatus(eventId: string): Promise<{
    event: any;
    deliveries: Array<{
      consumerId: string;
      consumerName: string;
      status: string;
      attempts: number;
      lastError?: string;
      deliveredAt?: Date;
    }>;
    summary: {
      totalConsumers: number;
      delivered: number;
      failed: number;
      pending: number;
      retrying: number;
    };
  }> {
    // Get the event
    const event = await this.prisma.processedEvent.findUnique({
      where: { eventId },
    });

    if (!event) {
      throw new Error(`Event ${eventId} not found`);
    }

    // Get all delivery records for this event
    const deliveries = await this.prisma.webhookEventDelivery.findMany({
      where: { eventId },
      include: {
        consumer: {
          select: { id: true, name: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const deliveryDetails = deliveries.map(delivery => ({
      consumerId: delivery.consumer.id,
      consumerName: delivery.consumer.name,
      status: delivery.status,
      attempts: delivery.attempts,
      lastError: delivery.lastError,
      deliveredAt: delivery.deliveredAt,
    }));

    // Calculate summary statistics
    const statusCounts = deliveries.reduce(
      (acc, delivery) => {
        acc[delivery.status] = (acc[delivery.status] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    return {
      event,
      deliveries: deliveryDetails,
      summary: {
        totalConsumers: deliveries.length,
        delivered: statusCounts.DELIVERED || 0,
        failed: statusCounts.FAILED || 0,
        pending: statusCounts.PENDING || 0,
        retrying: statusCounts.RETRYING || 0,
      },
    };
  }

  /**
   * Get events that have failed deliveries
   */
  async getEventsWithFailures(limit: number = 50): Promise<Array<{
    eventId: string;
    eventType: string;
    contractId: string;
    transactionHash: string;
    processedAt: Date;
    failedDeliveries: number;
    totalDeliveries: number;
  }>> {
    // This is a complex query - get events that have at least one failed delivery
    const eventsWithFailures = await this.prisma.$queryRaw<Array<any>>`
      SELECT 
        pe.event_id,
        pe.event_type,
        pe.contract_id,
        pe.transaction_hash,
        pe.processed_at,
        COUNT(CASE WHEN wed.status = 'FAILED' THEN 1 END) as failed_deliveries,
        COUNT(wed.id) as total_deliveries
      FROM processed_events pe
      INNER JOIN webhook_event_deliveries wed ON pe.event_id = wed.event_id
      WHERE wed.status = 'FAILED'
      GROUP BY pe.event_id, pe.event_type, pe.contract_id, pe.transaction_hash, pe.processed_at
      ORDER BY pe.processed_at DESC
      LIMIT ${limit}
    `;

    return eventsWithFailures.map(row => ({
      eventId: row.event_id,
      eventType: row.event_type,
      contractId: row.contract_id,
      transactionHash: row.transaction_hash,
      processedAt: row.processed_at,
      failedDeliveries: parseInt(row.failed_deliveries),
      totalDeliveries: parseInt(row.total_deliveries),
    }));
  }

  /**
   * Reprocess an event for specific consumers (useful for retry scenarios)
   */
  async reprocessEventForConsumers(
    eventId: string,
    consumerIds?: string[],
  ): Promise<{ reprocessed: number }> {
    const whereClause: any = { eventId };
    if (consumerIds && consumerIds.length > 0) {
      whereClause.consumerId = { in: consumerIds };
    }

    // Reset failed deliveries to pending for retry
    const updatedDeliveries = await this.prisma.webhookEventDelivery.updateMany({
      where: {
        ...whereClause,
        status: { in: ['FAILED', 'RETRYING'] },
      },
      data: {
        status: 'PENDING',
        attempts: 0,
        lastError: null,
      },
    });

    this.logger.log(
      `Reset ${updatedDeliveries.count} deliveries for event ${eventId} to retry`,
    );

    // Trigger immediate processing
    await this.webhookDeliveryService.processPendingDeliveries();

    return { reprocessed: updatedDeliveries.count };
  }

  /**
   * Get delivery statistics across all events
   */
  async getGlobalDeliveryStats(): Promise<{
    totalEvents: number;
    totalDeliveries: number;
    deliveryStats: {
      delivered: number;
      failed: number;
      pending: number;
      retrying: number;
    };
    consumerStats: Array<{
      consumerId: string;
      consumerName: string;
      totalDeliveries: number;
      successRate: number;
    }>;
  }> {
    // Get total events
    const totalEvents = await this.prisma.processedEvent.count();

    // Get delivery status counts
    const deliveryStats = await this.prisma.webhookEventDelivery.groupBy({
      by: ['status'],
      _count: { status: true },
    });

    const statusCounts = deliveryStats.reduce(
      (acc, stat) => {
        acc[stat.status] = stat._count.status;
        return acc;
      },
      { DELIVERED: 0, FAILED: 0, PENDING: 0, RETRYING: 0, DISABLED: 0 },
    );

    const totalDeliveries = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);

    // Get per-consumer stats
    const consumerStats = await this.prisma.webhookConsumer.findMany({
      select: {
        id: true,
        name: true,
        _count: {
          select: {
            deliveries: true,
          },
        },
        deliveries: {
          where: {
            status: 'DELIVERED',
          },
          select: {
            id: true,
          },
        },
      },
    });

    const consumerStatsFormatted = consumerStats.map(consumer => {
      const totalDeliveries = consumer._count.deliveries;
      const successfulDeliveries = consumer.deliveries.length;
      const successRate = totalDeliveries > 0 ? (successfulDeliveries / totalDeliveries) * 100 : 0;

      return {
        consumerId: consumer.id,
        consumerName: consumer.name,
        totalDeliveries,
        successRate: Math.round(successRate * 100) / 100,
      };
    });

    return {
      totalEvents,
      totalDeliveries,
      deliveryStats: {
        delivered: statusCounts.DELIVERED,
        failed: statusCounts.FAILED,
        pending: statusCounts.PENDING,
        retrying: statusCounts.RETRYING,
      },
      consumerStats: consumerStatsFormatted,
    };
  }

  /**
   * Clean up old events and their associated delivery records
   */
  async cleanupOldEvents(olderThanDays: number = 90): Promise<{
    eventsDeleted: number;
    deliveriesDeleted: number;
  }> {
    const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

    // Delete old delivery records first (due to foreign key constraints)
    const deliveriesDeleted = await this.webhookDeliveryService.cleanupOldDeliveries(olderThanDays);

    // Delete old events
    const eventsDeleted = await this.prisma.processedEvent.deleteMany({
      where: {
        processedAt: { lt: cutoffDate },
      },
    });

    this.logger.log(
      `Cleaned up ${eventsDeleted.count} old events and ${deliveriesDeleted} delivery records`,
    );

    return {
      eventsDeleted: eventsDeleted.count,
      deliveriesDeleted,
    };
  }
}