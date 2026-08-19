import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { createHmac } from 'crypto';
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { WebhookConsumer } from '../entities/webhook-consumer.entity';
import { StellarEvent } from '../entities/stellar-event.entity';
import { ConsumerManagementService } from './consumer-management.service';
import { EventStorageService } from './event-storage.service';
import { DeliveryStatus, EventType } from '../types/stellar.types';
import { WebhookDeliveryJobData } from '../processors/webhook-delivery.processor';
import { validateWebhookUrl } from '../utils/ssrf.util';

interface DeliveryResult {
  success: boolean;
  statusCode?: number;
  errorMessage?: string;
  responseTime?: number;
}

@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);
  private readonly httpClient: AxiosInstance;

  /** Exponential backoff schedule between attempts: 1s, 5s, 30s, 5m, 30m. */
  static readonly RETRY_DELAYS_MS = [1000, 5000, 30000, 300000, 1800000];
  /** Max delivery attempts before an event is moved to the dead-letter state. */
  static readonly MAX_ATTEMPTS = 5;
  /** Outbound HMAC signature header name. */
  static readonly SIGNATURE_HEADER = 'X-Stellara-Signature';

  // Keys (`${eventId}:${consumerId}`) already delivered — guarantees idempotency
  // so a duplicate queue entry or retry can never double-deliver.
  private readonly delivered = new Set<string>();
  // Keys currently queued/in-flight — prevents queueing the same pair twice.
  private readonly inFlight = new Set<string>();

  constructor(
    @InjectQueue('webhook-delivery')
    private readonly deliveryQueue: Queue<WebhookDeliveryJobData>,
    private readonly consumerManagementService: ConsumerManagementService,
    private readonly eventStorageService: EventStorageService,
  ) {
    this.httpClient = axios.create({
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Stellar-Monitor/1.0',
      },
    });
  }

  private deliveryKey(eventId: string, consumerId: string): string {
    return `${eventId}:${consumerId}`;
  }

  async queueEventForDelivery(event: StellarEvent): Promise<void> {
    const activeConsumers =
      await this.consumerManagementService.getActiveConsumers();

    if (activeConsumers.length === 0) {
      this.logger.debug('No active consumers, marking event as processed');
      await this.eventStorageService.markEventAsProcessed(event.id);
      return;
    }

    for (const consumer of activeConsumers) {
      const key = this.deliveryKey(event.id, consumer.id);
      if (this.delivered.has(key) || this.inFlight.has(key)) {
        this.logger.debug(
          `Skipping duplicate queue for event ${event.id} / consumer ${consumer.id}`,
        );
        continue;
      }
      this.inFlight.add(key);
      await this.deliveryQueue.add(
        { event, consumer },
        {
          attempts: consumer.maxRetries,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: true,
        },
      );
      this.logger.debug(`Queued event ${event.id} for consumer ${consumer.id}`);
    }
  }

  /** Called by WebhookDeliveryProcessor — delivers one event to one consumer. */
  async deliverEventToConsumer(
    event: StellarEvent,
    consumer: WebhookConsumer,
    attempt: number,
  ): Promise<void> {
    const startTime = Date.now();
    const key = this.deliveryKey(event.id, consumer.id);

    // Idempotency: never deliver the same event to the same consumer twice.
    if (this.delivered.has(key)) {
      this.logger.debug(
        `Event ${event.id} already delivered to consumer ${consumer.id}, skipping`,
      );
      return;
    }

    try {
      const freshConsumer =
        await this.consumerManagementService.getConsumerById(consumer.id);
      if (!freshConsumer.isActive) {
        this.logger.debug(
          `Skipping delivery to inactive consumer ${consumer.id}`,
        );
        this.inFlight.delete(key);
        return;
      }

      // SSRF protection: validate the (possibly re-pointed) URL right before
      // calling it. An unsafe URL is permanently undeliverable — dead-letter it
      // immediately rather than retrying.
      try {
        await validateWebhookUrl(freshConsumer.url);
      } catch (ssrfError) {
        this.logger.warn(
          `Refusing delivery to unsafe URL for consumer ${consumer.id}: ${ssrfError.message}`,
        );
        await this.moveToDeadLetter(
          event,
          consumer,
          attempt,
          ssrfError.message,
        );
        return;
      }

      const result = await this.attemptDelivery(event, freshConsumer, attempt);
      const responseTime = Date.now() - startTime;

      if (result.success) {
        this.delivered.add(key);
        this.inFlight.delete(key);
        this.logger.log(
          `Successfully delivered event ${event.id} to consumer ${consumer.id}`,
        );
        await this.handleSuccessfulDelivery(event, consumer, responseTime);
      } else {
        this.logger.warn(
          `Failed to deliver event ${event.id} to consumer ${consumer.id} (attempt ${attempt}): ${result.errorMessage}`,
        );
        await this.handleFailedDelivery(event, consumer, result, attempt);
        // Re-throw so Bull can apply retry/backoff
        throw new Error(result.errorMessage || 'Delivery failed');
      }
    } catch (error) {
      this.logger.error(
        `Exception during delivery to consumer ${consumer.id}: ${error.message}`,
        error.stack,
      );
      await this.handleFailedDelivery(
        event,
        consumer,
        { success: false, errorMessage: error.message },
        attempt,
      );
      throw error;
    }
  }

  private async attemptDelivery(
    event: StellarEvent,
    consumer: WebhookConsumer,
    attempt: number,
  ): Promise<DeliveryResult> {
    const payload = {
      id: event.id,
      eventType: event.eventType,
      ledgerSequence: event.ledgerSequence,
      timestamp: event.timestamp.toISOString(),
      transactionHash: event.transactionHash,
      sourceAccount: event.sourceAccount,
      payload: event.payload,
      deliveredAt: new Date().toISOString(),
    };

    const body = JSON.stringify(payload);

    const config: AxiosRequestConfig = {
      timeout: consumer.timeoutMs,
      headers: {
        'X-Stellar-Event-ID': event.id,
        'X-Stellar-Event-Type': event.eventType,
        'X-Delivery-Attempt': attempt.toString(),
        // Idempotency key lets consumers dedupe on their side too.
        'X-Idempotency-Key': this.deliveryKey(event.id, consumer.id),
      },
    };

    // Add HMAC-SHA256 signature if consumer has a secret so the consumer can
    // verify the payload originated from us and was not tampered with.
    // The secret is stored encrypted; decrypt it here for signing only.
    if (consumer.secret) {
      const plaintextSecret =
        await this.consumerManagementService.getDecryptedSecret(consumer.id);
      if (plaintextSecret) {
        config.headers = {
          ...config.headers,
          [WebhookDeliveryService.SIGNATURE_HEADER]: this.generateSignature(
            body,
            plaintextSecret,
          ),
        };
      }
    }

    try {
      const response = await this.httpClient.post(consumer.url, body, config);
      return { success: true, statusCode: response.status };
    } catch (error) {
      return {
        success: false,
        statusCode: error.response?.status,
        errorMessage: error.message,
      };
    }
  }

  private async handleSuccessfulDelivery(
    event: StellarEvent,
    consumer: WebhookConsumer,
    responseTime: number,
  ): Promise<void> {
    await this.eventStorageService.updateEventStatus(
      event.id,
      DeliveryStatus.DELIVERED,
      consumer.id,
    );

    // Update consumer stats and reset the in-flight attempt counter.
    await this.consumerManagementService.updateDeliveryStats(consumer.id, true);
    await this.consumerManagementService.recordDeliveryProgress(
      consumer.id,
      0,
      null,
    );

    const activeConsumers =
      await this.consumerManagementService.getActiveConsumers();
    const deliveredCount = (event.deliveredTo?.length || 0) + 1;
    if (deliveredCount >= activeConsumers.length) {
      await this.eventStorageService.markEventAsProcessed(event.id);
    }
  }

  private async handleFailedDelivery(
    event: StellarEvent,
    consumer: WebhookConsumer,
    result: DeliveryResult,
    attempt: number,
  ): Promise<void> {
    // Update consumer stats and record the attempt/error on the consumer.
    await this.consumerManagementService.updateDeliveryStats(
      consumer.id,
      false,
    );
    await this.consumerManagementService.recordDeliveryProgress(
      consumer.id,
      attempt,
      result.errorMessage ?? null,
    );

    if (attempt >= WebhookDeliveryService.MAX_ATTEMPTS) {
      // Max attempts reached — move to dead-letter.
      await this.moveToDeadLetter(
        event,
        consumer,
        attempt,
        result.errorMessage,
      );
      return;
    }

    // Bull handles the retry schedule via its own backoff config, so we only
    // need to update the event status here to reflect the pending retry.
    await this.eventStorageService.updateEventStatus(
      event.id,
      DeliveryStatus.RETRYING,
      consumer.id,
      result.errorMessage,
    );
  }

  private async moveToDeadLetter(
    event: StellarEvent,
    consumer: WebhookConsumer,
    attempt: number,
    errorMessage?: string,
  ): Promise<void> {
    this.inFlight.delete(this.deliveryKey(event.id, consumer.id));

    await this.eventStorageService.updateEventStatus(
      event.id,
      DeliveryStatus.DEAD_LETTER,
      consumer.id,
      errorMessage,
    );

    this.logger.error(
      `Event ${event.id} moved to dead-letter for consumer ${consumer.id} after ${attempt} attempt(s): ${errorMessage ?? 'unknown error'}`,
    );
  }

  /**
   * Returns the backoff delay (ms) to wait before the next attempt.
   * `attempt` is the 1-based number of the attempt that just failed.
   */
  private calculateBackoffDelay(attempt: number): number {
    const delays = WebhookDeliveryService.RETRY_DELAYS_MS;
    const index = Math.min(attempt - 1, delays.length - 1);
    return delays[index];
  }

  private generateSignature(payload: string, secret: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex');
  }

  async deliverTestEvent(consumerId: string): Promise<DeliveryResult> {
    const consumer =
      await this.consumerManagementService.getConsumerById(consumerId);

    if (!consumer.isActive) {
      return { success: false, errorMessage: 'Consumer is not active' };
    }

    // Validate the URL before sending a test event too.
    try {
      await validateWebhookUrl(consumer.url);
    } catch (error) {
      return { success: false, errorMessage: error.message };
    }

    const testEvent: Partial<StellarEvent> = {
      id: 'test-' + Date.now(),
      eventType: EventType.PAYMENT,
      ledgerSequence: 123456,
      timestamp: new Date(),
      transactionHash: 'test-transaction-hash',
      sourceAccount: 'test-source-account',
      payload: { test: true, message: 'This is a test event' },
    };

    return this.attemptDelivery(testEvent as StellarEvent, consumer, 1);
  }

  async getQueueSize(): Promise<number> {
    return this.deliveryQueue.count();
  }

  async getDeliveryStats(): Promise<{
    queueSize: number;
    activeConsumers: number;
    pendingEvents: number;
  }> {
    const [activeConsumers, pendingEvents, queueSize] = await Promise.all([
      this.consumerManagementService.getActiveConsumers(),
      this.eventStorageService.getPendingEvents(),
      this.deliveryQueue.count(),
    ]);

    return {
      queueSize,
      activeConsumers: activeConsumers.length,
      pendingEvents: pendingEvents.length,
    };
  }
}
