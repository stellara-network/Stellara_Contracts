import { Injectable, Logger } from '@nestjs/common';
import { EventListenerService, SorobanEvent } from '../events/event-listener.service';
import { StorageService } from '../storage/storage.service';
import { EventStorageService } from '../../webhook/event-storage.service';
import { IndexedEvent } from '../entities/indexed-event.entity';

export interface ProcessingResult {
  success: boolean;
  eventId: string;
  error?: string;
  retryCount: number;
  processedAt: Date;
}

export interface EventTransformer {
  contractId: string;
  eventName: string;
  transform: (event: SorobanEvent) => any;
}

@Injectable()
export class EventProcessorService {
  private readonly logger = new Logger(EventProcessorService.name);
  private readonly maxRetries = 3;
  private readonly retryDelay = 5000; // 5 seconds
  private processingQueue: SorobanEvent[] = [];
  private isProcessing = false;
  private transformers: Map<string, EventTransformer[]> = new Map();

  constructor(
    private eventListener: EventListenerService,
    private storage: StorageService,
    private eventStorageService: EventStorageService,
  ) {
    this.setupEventListeners();
    this.initializeTransformers();
  }

  private setupEventListeners(): void {
    this.eventListener.on('sorobanEvent', (event: SorobanEvent) => {
      this.addToQueue(event);
    });
  }

  private initializeTransformers(): void {
    // Register transformers for different contract events
    this.registerTransformer('token', 'transfer', this.transformTransferEvent);
    this.registerTransformer('token', 'approval', this.transformApprovalEvent);
    this.registerTransformer('amm', 'swap', this.transformSwapEvent);
    this.registerTransformer('amm', 'liquidity_added', this.transformLiquidityAddedEvent);
    this.registerTransformer('amm', 'liquidity_removed', this.transformLiquidityRemovedEvent);
  }

  registerTransformer(
    contractId: string,
    eventName: string,
    transformFn: (event: SorobanEvent) => any
  ): void {
    const key = `${contractId}:${eventName}`;
    const transformers = this.transformers.get(key) || [];
    transformers.push({
      contractId,
      eventName,
      transform: transformFn,
    });
    this.transformers.set(key, transformers);
  }

  async addToQueue(event: SorobanEvent): Promise<void> {
    // Check for idempotency
    const exists = await this.storage.eventExists(event.transactionHash);
    if (exists) {
      this.logger.debug(`Event already processed: ${event.transactionHash}`);
      return;
    }

    this.processingQueue.push(event);
    
    if (!this.isProcessing) {
      this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.processingQueue.length === 0) {
      return;
    }

    this.isProcessing = true;
    this.logger.debug(`Processing queue with ${this.processingQueue.length} events`);

    while (this.processingQueue.length > 0) {
      const event = this.processingQueue.shift()!;
      await this.processEvent(event);
    }

    this.isProcessing = false;
  }

  private async processEvent(event: SorobanEvent): Promise<ProcessingResult> {
    const startTime = Date.now();
    let retryCount = 0;

    while (retryCount <= this.maxRetries) {
      try {
        // Transform event data
        const transformedData = await this.transformEvent(event);
        
        // Store in database using legacy storage service
        const indexedEvent = await this.storage.storeEvent({
          ...event,
          eventData: transformedData,
          processedAt: new Date(),
        });

        // Store event and create webhook deliveries
        const stellarEvent = {
          id: event.id,
          eventType: this.extractEventName(event),
          contractId: event.contractId,
          transactionHash: event.transactionHash,
          eventData: transformedData,
          ledgerSeq: event.ledger,
          timestamp: new Date(event.timestamp),
        };

        await this.eventStorageService.storeEvent(stellarEvent);

        const processingTime = Date.now() - startTime;
        this.logger.debug(
          `Processed event ${event.transactionHash} in ${processingTime}ms with webhook delivery setup`
        );

        return {
          success: true,
          eventId: indexedEvent.id,
          retryCount,
          processedAt: new Date(),
        };

      } catch (error) {
        retryCount++;
        this.logger.error(
          `Error processing event ${event.transactionHash} (attempt ${retryCount}):`,
          error
        );

        if (retryCount <= this.maxRetries) {
          await this.sleep(this.retryDelay * retryCount);
        } else {
          // Log failed event for manual review
          await this.logFailedEvent(event, error);
          
          return {
            success: false,
            eventId: event.id,
            error: error.message,
            retryCount,
            processedAt: new Date(),
          };
        }
      }
    }

    // This should never be reached
    return {
      success: false,
      eventId: event.id,
      error: 'Max retries exceeded',
      retryCount,
      processedAt: new Date(),
    };
  }

  private async transformEvent(event: SorobanEvent): Promise<any> {
    const eventName = this.extractEventName(event);
    const key = `${event.contractId}:${eventName}`;
    const transformers = this.transformers.get(key) || [];

    if (transformers.length === 0) {
      // Default transformation
      return this.transformDefaultEvent(event);
    }

    // Apply all transformers (usually just one)
    let transformedData = { ...event };
    for (const transformer of transformers) {
      transformedData = transformer.transform(transformedData);
    }

    return transformedData;
  }

  private extractEventName(event: SorobanEvent): string {
    // Extract event name from topic or data
    if (event.topic && event.topic.length > 0) {
      return Buffer.from(event.topic[0], 'base64').toString('utf8');
    }

    // Try to parse from event data
    try {
      const parsed = JSON.parse(event.data);
      return parsed.eventName || parsed.name || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  // Event transformers
  private transformTransferEvent = (event: SorobanEvent): any => {
    try {
      const data = JSON.parse(event.data);
      return {
        ...event,
        eventName: 'transfer',
        eventData: {
          from: data.from,
          to: data.to,
          amount: data.amount,
          tokenAddress: data.token || event.contractId,
          timestamp: event.timestamp,
        },
      };
    } catch (error) {
      this.logger.error('Error transforming transfer event:', error);
      return this.transformDefaultEvent(event);
    }
  };

  private transformApprovalEvent = (event: SorobanEvent): any => {
    try {
      const data = JSON.parse(event.data);
      return {
        ...event,
        eventName: 'approval',
        eventData: {
          owner: data.owner,
          spender: data.spender,
          amount: data.amount,
          tokenAddress: data.token || event.contractId,
          timestamp: event.timestamp,
        },
      };
    } catch (error) {
      this.logger.error('Error transforming approval event:', error);
      return this.transformDefaultEvent(event);
    }
  };

  private transformSwapEvent = (event: SorobanEvent): any => {
    try {
      const data = JSON.parse(event.data);
      return {
        ...event,
        eventName: 'swap',
        eventData: {
          user: data.user,
          tokenIn: data.tokenIn,
          tokenOut: data.tokenOut,
          amountIn: data.amountIn,
          amountOut: data.amountOut,
          poolAddress: data.pool || event.contractId,
          timestamp: event.timestamp,
        },
      };
    } catch (error) {
      this.logger.error('Error transforming swap event:', error);
      return this.transformDefaultEvent(event);
    }
  };

  private transformLiquidityAddedEvent = (event: SorobanEvent): any => {
    try {
      const data = JSON.parse(event.data);
      return {
        ...event,
        eventName: 'liquidity_added',
        eventData: {
          provider: data.provider,
          tokenA: data.tokenA,
          tokenB: data.tokenB,
          amountA: data.amountA,
          amountB: data.amountB,
          poolAddress: data.pool || event.contractId,
          timestamp: event.timestamp,
        },
      };
    } catch (error) {
      this.logger.error('Error transforming liquidity_added event:', error);
      return this.transformDefaultEvent(event);
    }
  };

  private transformLiquidityRemovedEvent = (event: SorobanEvent): any => {
    try {
      const data = JSON.parse(event.data);
      return {
        ...event,
        eventName: 'liquidity_removed',
        eventData: {
          provider: data.provider,
          tokenA: data.tokenA,
          tokenB: data.tokenB,
          amountA: data.amountA,
          amountB: data.amountB,
          poolAddress: data.pool || event.contractId,
          timestamp: event.timestamp,
        },
      };
    } catch (error) {
      this.logger.error('Error transforming liquidity_removed event:', error);
      return this.transformDefaultEvent(event);
    }
  };

  private transformDefaultEvent(event: SorobanEvent): any {
    return {
      ...event,
      eventName: this.extractEventName(event),
      eventData: {
        contractId: event.contractId,
        topic: event.topic,
        data: event.data,
        timestamp: event.timestamp,
      },
    };
  }

  private async logFailedEvent(event: SorobanEvent, error: any): Promise<void> {
    this.logger.error(
      `Failed to process event ${event.transactionHash} after ${this.maxRetries} retries:`,
      error
    );

    // Store failed event for manual review
    await this.storage.storeFailedEvent({
      ...event,
      error: error.message,
      failedAt: new Date(),
      retryCount: this.maxRetries,
    });
  }

  async reprocessEvent(transactionHash: string): Promise<ProcessingResult> {
    const event = await this.storage.getEventByTransactionHash(transactionHash);
    if (!event) {
      throw new Error(`Event not found: ${transactionHash}`);
    }

    return this.processEvent(event);
  }

  async getProcessingStats(): Promise<{
    queueSize: number;
    isProcessing: boolean;
    processedCount: number;
    failedCount: number;
  }> {
    return {
      queueSize: this.processingQueue.length,
      isProcessing: this.isProcessing,
      processedCount: await this.storage.getProcessedEventCount(),
      failedCount: await this.storage.getFailedEventCount(),
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getRegisteredTransformers(): Array<{ contractId: string; eventName: string }> {
    const transformers: Array<{ contractId: string; eventName: string }> = [];
    
    for (const [key, transformerList] of this.transformers.entries()) {
      const [contractId, eventName] = key.split(':');
      transformers.push({ contractId, eventName });
    }

    return transformers;
  }
}
