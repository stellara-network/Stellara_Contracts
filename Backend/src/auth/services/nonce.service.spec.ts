import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NonceService } from './nonce.service';
import { LoginNonce } from '../entities/login-nonce.entity';
import { InvalidNonceError } from '../../common/exceptions/api-error.exception';

describe('NonceService', () => {
  let service: NonceService;

  const mockRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };

  // Repository returned by the transaction manager inside validateNonce()
  const mockManagerRepo = {
    findOne: jest.fn(),
    create: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockManager = {
    getRepository: jest.fn().mockReturnValue(mockManagerRepo),
  };

  const mockDataSource = {
    transaction: jest.fn((callback: (manager: unknown) => Promise<unknown>) =>
      callback(mockManager),
    ),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockManager.getRepository.mockReturnValue(mockManagerRepo);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NonceService,
        {
          provide: getRepositoryToken(LoginNonce),
          useValue: mockRepository,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<NonceService>(NonceService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('generateNonce', () => {
    it('should generate a nonce successfully', async () => {
      const publicKey = 'GABC123TEST';
      const mockNonce = {
        id: '1',
        nonce: 'test-nonce-uuid',
        publicKey,
        expiresAt: new Date(),
        used: false,
        createdAt: new Date(),
      };

      mockRepository.create.mockReturnValue(mockNonce);
      mockRepository.save.mockResolvedValue(mockNonce);

      const result = await service.generateNonce(publicKey);

      expect(result).toHaveProperty('nonce');
      expect(result).toHaveProperty('expiresAt');
      expect(result).toHaveProperty('message');
      expect(result.message).toContain('Sign this message');
      expect(mockRepository.create).toHaveBeenCalled();
      expect(mockRepository.save).toHaveBeenCalled();
    });

    it('should set expiration 5 minutes in the future', async () => {
      const publicKey = 'GABC123TEST';
      const beforeTime = Date.now();

      mockRepository.create.mockImplementation((data) => data);
      mockRepository.save.mockImplementation((data) => Promise.resolve(data));

      const result = await service.generateNonce(publicKey);
      const fiveMinutesMs = 5 * 60 * 1000;

      const expiresInMs = result.expiresAt.getTime() - beforeTime;
      expect(expiresInMs).toBeGreaterThanOrEqual(fiveMinutesMs);
      expect(expiresInMs).toBeLessThan(fiveMinutesMs + 5000);
    });
  });

  describe('validateNonce', () => {
    const nonce = 'valid-nonce';
    const publicKey = 'GABC123TEST';
    const futureExpiry = () => new Date(Date.now() + 300000);

    it('should validate a valid nonce and consume it atomically', async () => {
      const mockNonce = {
        id: '1',
        nonce,
        publicKey,
        expiresAt: futureExpiry(),
        used: false,
        createdAt: new Date(),
      };

      mockManagerRepo.findOne.mockResolvedValue(mockNonce);

      const queryBuilder = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ raw: [mockNonce] }),
      };
      mockManagerRepo.createQueryBuilder.mockReturnValue(queryBuilder);
      mockManagerRepo.create.mockReturnValue(mockNonce);

      const result = await service.validateNonce(nonce, publicKey);

      expect(result).toEqual(mockNonce);
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockManager.getRepository).toHaveBeenCalledWith(LoginNonce);
      expect(mockManagerRepo.findOne).toHaveBeenCalledWith({
        where: { nonce, publicKey },
      });
      expect(queryBuilder.execute).toHaveBeenCalled();
    });

    it('should throw error if nonce or public key is missing', async () => {
      await expect(service.validateNonce('', publicKey)).rejects.toThrow(
        InvalidNonceError,
      );
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it('should throw error if nonce not found', async () => {
      mockManagerRepo.findOne.mockResolvedValue(null);

      await expect(
        service.validateNonce('invalid-nonce', publicKey),
      ).rejects.toThrow(InvalidNonceError);
    });

    it('should throw error if nonce already used', async () => {
      const mockNonce = {
        id: '1',
        nonce: 'used-nonce',
        publicKey,
        expiresAt: futureExpiry(),
        used: true,
        createdAt: new Date(),
      };

      mockManagerRepo.findOne.mockResolvedValue(mockNonce);

      await expect(
        service.validateNonce('used-nonce', publicKey),
      ).rejects.toThrow(InvalidNonceError);
    });

    it('should throw error if nonce expired', async () => {
      const mockNonce = {
        id: '1',
        nonce: 'expired-nonce',
        publicKey,
        expiresAt: new Date(Date.now() - 1000),
        used: false,
        createdAt: new Date(),
      };

      mockManagerRepo.findOne.mockResolvedValue(mockNonce);

      await expect(
        service.validateNonce('expired-nonce', publicKey),
      ).rejects.toThrow(InvalidNonceError);
    });
  });

  describe('markNonceUsed', () => {
    it('should mark nonce as used', async () => {
      const nonce = 'test-nonce';
      mockRepository.update.mockResolvedValue({ affected: 1 });

      await service.markNonceUsed(nonce);

      expect(mockRepository.update).toHaveBeenCalledWith(
        { nonce },
        { used: true },
      );
    });
  });

  describe('cleanupExpiredNonces', () => {
    it('should delete expired nonces', async () => {
      mockRepository.delete.mockResolvedValue({ affected: 5 });

      await service.cleanupExpiredNonces();

      expect(mockRepository.delete).toHaveBeenCalled();
    });
  });
});
