import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { EventStorageService } from './event-storage.service';
import { PrismaService } from '../prisma/prisma.service';

describe('WebhookController', () => {
  let controller: WebhookController;
  let prismaService: jest.Mocked<PrismaService>;
  let webhookDeliveryService: jest.Mocked<WebhookDeliveryService>;
  let eventStorageService: jest.Mocked<EventStorageService>;

  const mockConsumer = {
    id: 'test-consumer-id',
    name: 'Test Consumer',
    url: 'https://api.example.com/webhook',
    active: true,
    maxRetries: 3,
    retryDelayMs: 5000,
    timeout: 30000,
    eventTypes: ['transfer'],
    contractIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    _count: { deliveries: 10 },
  };

  const mockStats = {
    total: 100,
    pending: 5,
    delivered: 85,
    failed: 10,
    retrying: 0,
    successRate: 85,
  };

  beforeEach(async () => {
    const mockPrismaService = {
      webhookConsumer: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      webhookEventDelivery: {
        findMany: jest.fn(),
        create: jest.fn(),
        findUnique: jest.fn(),
      },
    };

    const mockWebhookDeliveryService = {
      getConsumerStats: jest.fn(),
      retryFailedDeliveries: jest.fn(),
      processPendingDeliveries: jest.fn(),
    };

    const mockEventStorageService = {
      getEventDeliveryStatus: jest.fn(),
      reprocessEventForConsumers: jest.fn(),
      getGlobalDeliveryStats: jest.fn(),
      getEventsWithFailures: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: WebhookDeliveryService,
          useValue: mockWebhookDeliveryService,
        },
        {
          provide: EventStorageService,
          useValue: mockEventStorageService,
        },
      ],
    }).compile();

    controller = module.get<WebhookController>(WebhookController);
    prismaService = module.get(PrismaService);
    webhookDeliveryService = module.get(WebhookDeliveryService);
    eventStorageService = module.get(EventStorageService);
  });

  describe('createConsumer', () => {
    it('should create a webhook consumer', async () => {
      const createDto = {
        name: 'Test Consumer',
        url: 'https://api.example.com/webhook',
        eventTypes: ['transfer'],
      };

      prismaService.webhookConsumer.create.mockResolvedValue(mockConsumer as any);

      const result = await controller.createConsumer(createDto);

      expect(result.status).toBe(201);
      expect(result.data).toEqual(mockConsumer);
      expect(prismaService.webhookConsumer.create).toHaveBeenCalledWith({
        data: {
          name: createDto.name,
          url: createDto.url,
          eventTypes: createDto.eventTypes,
          contractIds: [],
          maxRetries: 3,
          retryDelayMs: 5000,
          timeout: 30000,
          secret: undefined,
          description: undefined,
          tags: undefined,
        },
      });
    });

    it('should throw BadRequestException for invalid URL', async () => {
      const createDto = {
        name: 'Test Consumer',
        url: 'invalid-url',
      };

      await expect(controller.createConsumer(createDto)).rejects.toThrow(BadRequestException);
    });
  });

  describe('listConsumers', () => {
    it('should list consumers with stats', async () => {
      const consumers = [mockConsumer];
      
      prismaService.webhookConsumer.findMany.mockResolvedValue(consumers as any);
      webhookDeliveryService.getConsumerStats.mockResolvedValue(mockStats);

      const result = await controller.listConsumers();

      expect(result.status).toBe(200);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].stats).toEqual(mockStats);
    });

    it('should filter by active status', async () => {
      prismaService.webhookConsumer.findMany.mockResolvedValue([]);
      
      await controller.listConsumers('true');

      expect(prismaService.webhookConsumer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { active: true },
        }),
      );
    });
  });

  describe('getConsumer', () => {
    it('should get consumer with stats', async () => {
      prismaService.webhookConsumer.findUnique.mockResolvedValue(mockConsumer as any);
      webhookDeliveryService.getConsumerStats.mockResolvedValue(mockStats);

      const result = await controller.getConsumer('test-id');

      expect(result.status).toBe(200);
      expect(result.data.stats).toEqual(mockStats);
    });

    it('should throw NotFoundException for non-existent consumer', async () => {
      prismaService.webhookConsumer.findUnique.mockResolvedValue(null);

      await expect(controller.getConsumer('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('retryConsumerDeliveries', () => {
    it('should retry failed deliveries', async () => {
      const retryCount = 5;
      webhookDeliveryService.retryFailedDeliveries.mockResolvedValue(retryCount);

      const result = await controller.retryConsumerDeliveries('test-id');

      expect(result.status).toBe(200);
      expect(result.data.retryCount).toBe(retryCount);
      expect(webhookDeliveryService.retryFailedDeliveries).toHaveBeenCalledWith('test-id');
    });
  });

  describe('testConsumer', () => {
    it('should create and process test delivery', async () => {
      const testDelivery = {
        id: 'test-delivery-id',
        consumerId: 'test-consumer-id',
        eventId: expect.stringMatching(/^test-\d+$/),
        status: 'DELIVERED',
        attempts: 1,
        responseStatus: 200,
        responseTime: 150,
        lastError: null,
        consumer: mockConsumer,
      };

      prismaService.webhookConsumer.findUnique.mockResolvedValue(mockConsumer as any);
      prismaService.webhookEventDelivery.create.mockResolvedValue(testDelivery as any);
      prismaService.webhookEventDelivery.findUnique.mockResolvedValue(testDelivery as any);

      const result = await controller.testConsumer('test-consumer-id');

      expect(result.status).toBe(200);
      expect(result.data.deliveryStatus).toBe('DELIVERED');
    });

    it('should throw NotFoundException for non-existent consumer', async () => {
      prismaService.webhookConsumer.findUnique.mockResolvedValue(null);

      await expect(controller.testConsumer('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getEventDeliveries', () => {
    it('should get event delivery status', async () => {
      const deliveryStatus = {
        event: { id: 'event-1', eventType: 'transfer' },
        deliveries: [],
        summary: { totalConsumers: 0, delivered: 0, failed: 0, pending: 0, retrying: 0 },
      };

      eventStorageService.getEventDeliveryStatus.mockResolvedValue(deliveryStatus);

      const result = await controller.getEventDeliveries('event-1');

      expect(result.status).toBe(200);
      expect(result.data).toEqual(deliveryStatus);
    });

    it('should throw NotFoundException for non-existent event', async () => {
      eventStorageService.getEventDeliveryStatus.mockRejectedValue(new Error('Event not found'));

      await expect(controller.getEventDeliveries('non-existent')).rejects.toThrow();
    });
  });

  describe('reprocessEvent', () => {
    it('should reprocess event for all consumers', async () => {
      const reprocessResult = { reprocessed: 3 };
      
      eventStorageService.reprocessEventForConsumers.mockResolvedValue(reprocessResult);

      const result = await controller.reprocessEvent('event-1', {});

      expect(result.status).toBe(200);
      expect(result.data.reprocessed).toBe(3);
      expect(eventStorageService.reprocessEventForConsumers).toHaveBeenCalledWith('event-1', undefined);
    });

    it('should reprocess event for specific consumers', async () => {
      const consumerIds = ['consumer-1', 'consumer-2'];
      const reprocessResult = { reprocessed: 2 };
      
      eventStorageService.reprocessEventForConsumers.mockResolvedValue(reprocessResult);

      await controller.reprocessEvent('event-1', { consumerIds });

      expect(eventStorageService.reprocessEventForConsumers).toHaveBeenCalledWith('event-1', consumerIds);
    });
  });

  describe('getGlobalStats', () => {
    it('should return global delivery statistics', async () => {
      const globalStats = {
        totalEvents: 1000,
        totalDeliveries: 2500,
        deliveryStats: { delivered: 2200, failed: 200, pending: 50, retrying: 50 },
        consumerStats: [],
      };

      eventStorageService.getGlobalDeliveryStats.mockResolvedValue(globalStats);

      const result = await controller.getGlobalStats();

      expect(result.status).toBe(200);
      expect(result.data).toEqual(globalStats);
    });
  });

  describe('getEventsWithFailures', () => {
    it('should return events with delivery failures', async () => {
      const failedEvents = [
        {
          eventId: 'event-1',
          eventType: 'transfer',
          contractId: 'contract-1',
          transactionHash: 'tx-1',
          processedAt: new Date(),
          failedDeliveries: 2,
          totalDeliveries: 5,
        },
      ];

      eventStorageService.getEventsWithFailures.mockResolvedValue(failedEvents);

      const result = await controller.getEventsWithFailures('10');

      expect(result.status).toBe(200);
      expect(result.data).toEqual(failedEvents);
      expect(eventStorageService.getEventsWithFailures).toHaveBeenCalledWith(10);
    });
  });
});