import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from '@nestjs/config';
import { IndexerService } from './indexer.service';
import { EventListenerService } from './events/event-listener.service';
import { EventProcessorService } from './processors/event-processor.service';
import { StorageService } from './storage/storage.service';
import { HealthCheckService } from './health/health-check.service';
import { LedgerTrackerService } from './services/ledger-tracker.service';
import { EventHandlerService } from './services/event-handler.service';
import { DatabaseModule } from '../database.module';
import { WebhookDeliveryService } from '../webhook/webhook-delivery.service';
import { EventStorageService } from '../webhook/event-storage.service';
import stellarConfig, { indexerConfig } from '../config/stellar.config';

/**
 * Blockchain Indexer Module
 *
 * This module provides background indexing of Stellar blockchain events
 * to synchronize on-chain state with local database.
 */
@Module({
  imports: [
    // Enable scheduled tasks
    ScheduleModule.forRoot(),
    // Database access
    DatabaseModule,
    // Configuration
    ConfigModule.forFeature(stellarConfig),
    ConfigModule.forFeature(indexerConfig),
  ],
  providers: [
    // Core indexer service
    IndexerService,
    // Event processing
    EventListenerService,
    EventProcessorService,
    StorageService,
    HealthCheckService,
    // Ledger state tracking
    LedgerTrackerService,
    EventHandlerService,
    // Webhook services
    WebhookDeliveryService,
    EventStorageService,
  ],
  exports: [
    // Export services for potential external use
    IndexerService,
    EventListenerService,
    EventProcessorService,
    StorageService,
    HealthCheckService,
    LedgerTrackerService,
    EventHandlerService,
    WebhookDeliveryService,
    EventStorageService,
  ],
})
export class IndexerModule {}
