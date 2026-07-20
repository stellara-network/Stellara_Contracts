import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { EventStorageService } from './event-storage.service';
import { WebhookRetryTask } from './webhook-retry.task';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [WebhookController],
  providers: [
    WebhookDeliveryService,
    EventStorageService,
    WebhookRetryTask,
    PrismaService,
  ],
  exports: [
    WebhookDeliveryService,
    EventStorageService,
  ],
})
export class WebhookModule {}