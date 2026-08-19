import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StellarEvent } from '../entities/stellar-event.entity';
import { EventType, DeliveryStatus } from '../types/stellar.types';
import { StellarEventDto } from '../dto/stellar-event.dto';

@Injectable()
export class EventStorageService {
  private readonly logger = new Logger(EventStorageService.name);

  constructor(
    @InjectRepository(StellarEvent)
    private readonly eventRepository: Repository<StellarEvent>,
  ) {}

  async saveEvent(eventData: StellarEventDto): Promise<StellarEvent> {
    try {
      const event = this.eventRepository.create({
        ...eventData,
        timestamp: new Date(eventData.timestamp),
        deliveryStatus: DeliveryStatus.PENDING,
        deliveryAttempts: 0,
        isProcessed: false,
      });

      const savedEvent = await this.eventRepository.save(event);
      this.logger.log(
        `Saved event ${savedEvent.id} of type ${savedEvent.eventType}`,
      );
      return savedEvent;
    } catch (error) {
      this.logger.error(`Failed to save event: ${error.message}`, error.stack);
      throw error;
    }
  }

  async getEventById(id: string): Promise<StellarEvent | null> {
    return this.eventRepository.findOne({ where: { id } });
  }

  async getEvents(
    page: number = 1,
    limit: number = 50,
    eventType?: EventType,
    startDate?: Date,
    endDate?: Date,
    deliveryStatus?: DeliveryStatus,
  ): Promise<[StellarEvent[], number]> {
    const queryBuilder = this.eventRepository.createQueryBuilder('event');

    if (eventType) {
      queryBuilder.andWhere('event.eventType = :eventType', { eventType });
    }

    if (startDate) {
      queryBuilder.andWhere('event.timestamp >= :startDate', { startDate });
    }

    if (endDate) {
      queryBuilder.andWhere('event.timestamp <= :endDate', { endDate });
    }

    if (deliveryStatus) {
      queryBuilder.andWhere('event.deliveryStatus = :deliveryStatus', {
        deliveryStatus,
      });
    }

    return queryBuilder
      .orderBy('event.timestamp', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
  }

  async getRecentEvents(limit: number = 100): Promise<StellarEvent[]> {
    return this.eventRepository.find({
      order: { timestamp: 'DESC' },
      take: limit,
    });
  }

  async getPendingEvents(limit: number = 50): Promise<StellarEvent[]> {
    return this.eventRepository.find({
      where: {
        deliveryStatus: DeliveryStatus.PENDING,
        isProcessed: false,
      },
      order: { createdAt: 'ASC' },
      take: limit,
    });
  }

  async updateEventStatus(
    eventId: string,
    status: DeliveryStatus,
    consumerId?: string,
    errorMessage?: string,
  ): Promise<StellarEvent> {
    const event = await this.getEventById(eventId);
    if (!event) {
      throw new Error(`Event ${eventId} not found`);
    }

    event.deliveryStatus = status;
    event.deliveryAttempts += 1;
    event.lastAttemptAt = new Date();

    if (status === DeliveryStatus.DELIVERED) {
      event.deliveredAt = new Date();
      if (consumerId) {
        event.deliveredTo = event.deliveredTo || [];
        if (!event.deliveredTo.includes(consumerId)) {
          event.deliveredTo.push(consumerId);
        }
      }
    } else if (status === DeliveryStatus.FAILED && consumerId) {
      event.failedDeliveries = event.failedDeliveries || [];
      if (!event.failedDeliveries.includes(consumerId)) {
        event.failedDeliveries.push(consumerId);
      }
    }

    if (errorMessage) {
      event.errorMessage = errorMessage;
    }

    return this.eventRepository.save(event);
  }

  async markEventAsProcessed(eventId: string): Promise<StellarEvent> {
    const event = await this.getEventById(eventId);
    if (!event) {
      throw new Error(`Event ${eventId} not found`);
    }

    event.isProcessed = true;
    return this.eventRepository.save(event);
  }

  async getStats(): Promise<{
    totalEvents: number;
    pendingEvents: number;
    deliveredEvents: number;
    failedEvents: number;
    eventsByType: Record<EventType, number>;
    eventsByDay: Array<{ date: string; count: number }>;
  }> {
    const totalEvents = await this.eventRepository.count();
    const pendingEvents = await this.eventRepository.count({
      where: { deliveryStatus: DeliveryStatus.PENDING },
    });
    const deliveredEvents = await this.eventRepository.count({
      where: { deliveryStatus: DeliveryStatus.DELIVERED },
    });
    const failedEvents = await this.eventRepository.count({
      where: { deliveryStatus: DeliveryStatus.FAILED },
    });

    // Count by event type
    const eventsByType: Record<EventType, number> = {} as Record<
      EventType,
      number
    >;
    for (const eventType of Object.values(EventType)) {
      eventsByType[eventType] = await this.eventRepository.count({
        where: { eventType },
      });
    }

    // Events by day (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const dailyCounts = await this.eventRepository
      .createQueryBuilder('event')
      .select('DATE(event.timestamp) as date')
      .addSelect('COUNT(*) as count')
      .where('event.timestamp >= :thirtyDaysAgo', { thirtyDaysAgo })
      .groupBy('DATE(event.timestamp)')
      .orderBy('date', 'ASC')
      .getRawMany();

    const eventsByDay = dailyCounts.map((row) => ({
      date: row.date,
      count: parseInt(row.count, 10),
    }));

    return {
      totalEvents,
      pendingEvents,
      deliveredEvents,
      failedEvents,
      eventsByType,
      eventsByDay,
    };
  }

  async cleanupOldEvents(daysToKeep: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const result = await this.eventRepository
      .createQueryBuilder()
      .delete()
      .from(StellarEvent)
      .where('createdAt < :cutoffDate', { cutoffDate })
      .execute();

    this.logger.log(`Cleaned up ${result.affected} old events`);
    return result.affected || 0;
  }
}
