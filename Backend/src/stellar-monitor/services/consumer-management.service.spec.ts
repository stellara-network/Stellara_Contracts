import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConsumerManagementService } from './consumer-management.service';
import { WebhookConsumer } from '../entities/webhook-consumer.entity';
import { CreateConsumerDto } from '../dto/create-consumer.dto';
import { WebhookSecretService } from './webhook-secret.service';

describe('ConsumerManagementService', () => {
  let service: ConsumerManagementService;
  let repository: Repository<WebhookConsumer>;

  const mockQueryBuilder = {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn(),
  };

  const mockConsumerRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    remove: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn(() => mockQueryBuilder),
  };

  const mockSecretService = {
    encrypt: jest.fn((s: string) => `enc:${s}`),
    decrypt: jest.fn((s: string) => s.replace(/^enc:/, '')),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConsumerManagementService,
        {
          provide: getRepositoryToken(WebhookConsumer),
          useValue: mockConsumerRepository,
        },
        {
          provide: WebhookSecretService,
          useValue: mockSecretService,
        },
      ],
    }).compile();

    service = module.get<ConsumerManagementService>(ConsumerManagementService);
    repository = module.get<Repository<WebhookConsumer>>(
      getRepositoryToken(WebhookConsumer),
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createConsumer', () => {
    it('should create a new consumer', async () => {
      const createDto: CreateConsumerDto = {
        name: 'Test Consumer',
        url: 'https://example.com/webhook',
        maxRetries: 3,
        timeoutMs: 5000,
      };

      const consumer = new WebhookConsumer();
      Object.assign(consumer, createDto, { id: 'test-id', isActive: true });

      mockConsumerRepository.findOne.mockResolvedValue(null);
      mockConsumerRepository.create.mockReturnValue(consumer);
      mockConsumerRepository.save.mockResolvedValue(consumer);

      const result = await service.createConsumer(createDto);

      expect(result).toEqual(consumer);
      expect(mockConsumerRepository.findOne).toHaveBeenCalledWith({
        where: { url: createDto.url },
      });
      expect(mockConsumerRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: createDto.name,
          url: createDto.url,
          status: 'active',
        }),
      );
      expect(mockConsumerRepository.save).toHaveBeenCalledWith(consumer);
    });

    it('should encrypt the secret when provided', async () => {
      const createDto: CreateConsumerDto = {
        name: 'Test Consumer',
        url: 'https://example.com/webhook',
        secret: 'my-signing-secret',
      };

      const consumer = new WebhookConsumer();
      mockConsumerRepository.findOne.mockResolvedValue(null);
      mockConsumerRepository.create.mockReturnValue(consumer);
      mockConsumerRepository.save.mockResolvedValue(consumer);

      await service.createConsumer(createDto);

      expect(mockSecretService.encrypt).toHaveBeenCalledWith(
        'my-signing-secret',
      );
      expect(mockConsumerRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ secret: 'enc:my-signing-secret' }),
      );
    });
  });

  describe('getDecryptedSecret', () => {
    it('returns the decrypted secret for a consumer', async () => {
      const consumer = new WebhookConsumer();
      consumer.id = 'consumer-1';
      consumer.secret = 'enc:supersecret';
      mockConsumerRepository.findOne.mockResolvedValue(consumer);

      const result = await service.getDecryptedSecret('consumer-1');
      expect(result).toBe('supersecret');
    });

    it('returns undefined when consumer has no secret', async () => {
      const consumer = new WebhookConsumer();
      consumer.id = 'consumer-1';
      (consumer as any).secret = undefined;
      mockConsumerRepository.findOne.mockResolvedValue(consumer);

      const result = await service.getDecryptedSecret('consumer-1');
      expect(result).toBeUndefined();
    });
  });

  describe('rotateSecret', () => {
    it('encrypts and saves the new secret', async () => {
      const consumer = new WebhookConsumer();
      consumer.id = 'consumer-1';
      consumer.secret = 'enc:old-secret';
      mockConsumerRepository.findOne.mockResolvedValue(consumer);
      mockConsumerRepository.save.mockResolvedValue(consumer);

      await service.rotateSecret('consumer-1', 'new-secret');

      expect(mockSecretService.encrypt).toHaveBeenCalledWith('new-secret');
      expect(consumer.secret).toBe('enc:new-secret');
      expect(mockConsumerRepository.save).toHaveBeenCalledWith(consumer);
    });
  });

  describe('getAllConsumers', () => {
    it('should return all consumers', async () => {
      const consumers = [new WebhookConsumer(), new WebhookConsumer()];
      mockQueryBuilder.getMany.mockResolvedValue(consumers);

      const result = await service.getAllConsumers();

      expect(result).toEqual(consumers);
      expect(mockConsumerRepository.createQueryBuilder).toHaveBeenCalled();
      expect(mockQueryBuilder.getMany).toHaveBeenCalled();
    });
  });
});
