import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { WebhookDeliveryService } from '../services/webhook-delivery.service';
import { StellarEvent } from '../entities/stellar-event.entity';
import { WebhookConsumer } from '../entities/webhook-consumer.entity';

export interface WebhookDeliveryJobData {
  event: StellarEvent;
  consumer: WebhookConsumer;
}

@Processor('webhook-delivery')
export class WebhookDeliveryProcessor {
  private readonly logger = new Logger(WebhookDeliveryProcessor.name);

  constructor(
    private readonly webhookDeliveryService: WebhookDeliveryService,
  ) {}

  @Process()
  async handle(job: Job<WebhookDeliveryJobData>): Promise<void> {
    const { event, consumer } = job.data;
    this.logger.debug(
      `Processing webhook delivery job ${job.id}: event ${event.id} -> consumer ${consumer.id}`,
    );
    await this.webhookDeliveryService.deliverEventToConsumer(
      event,
      consumer,
      job.attemptsMade + 1,
    );
  }
}
