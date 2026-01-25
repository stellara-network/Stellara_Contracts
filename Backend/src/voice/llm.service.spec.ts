import { Test, TestingModule } from '@nestjs/testing';
import { LlmService } from './services/llm.service';
import { RedisService } from '../redis/redis.service';
import { HttpException, HttpStatus } from '@nestjs/common';

describe('LlmService', () => {
  let service: LlmService;
  let redisService: RedisService;

  const mockRedisClient = {
    get: jest.fn(),
    set: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
  };

  const mockRedisService = {
    client: mockRedisClient,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LlmService,
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
      ],
    }).compile();

    service = module.get<LlmService>(LlmService);
    redisService = module.get<RedisService>(RedisService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('generateResponse', () => {
    const userId = 'user123';
    const prompt = 'Hello';

    it('should return cached response if available', async () => {
      mockRedisClient.incr.mockResolvedValue(1); // Quota check
      mockRedisClient.incr.mockResolvedValueOnce(1); // RPM check
      mockRedisClient.get.mockResolvedValue('cached response');

      const result = await service.generateResponse(userId, prompt);

      expect(result).toEqual({ content: 'cached response', cached: true });
      expect(mockRedisClient.get).toHaveBeenCalled();
    });

    it('should call LLM and cache response if not in cache', async () => {
      mockRedisClient.incr.mockResolvedValue(1); // Quota check
      mockRedisClient.incr.mockResolvedValueOnce(1); // RPM check
      mockRedisClient.get.mockResolvedValue(null);
      mockRedisClient.set.mockResolvedValue('OK');

      const result = await service.generateResponse(userId, prompt);

      expect(result.cached).toBe(false);
      expect(result.content).toBeDefined();
      expect(mockRedisClient.set).toHaveBeenCalled();
    });

    it('should throw error if monthly quota is exceeded', async () => {
      mockRedisClient.incr.mockResolvedValue(1001); // Exceed quota

      await expect(service.generateResponse(userId, prompt)).rejects.toThrow(
        new HttpException('Monthly usage quota exceeded. Please contact support.', HttpStatus.TOO_MANY_REQUESTS)
      );
    });

    it('should throw error if rate limit is exceeded', async () => {
      mockRedisClient.incr.mockResolvedValueOnce(1); // Quota OK
      mockRedisClient.incr.mockResolvedValueOnce(21); // Exceed RPM

      await expect(service.generateResponse(userId, prompt)).rejects.toThrow(
        new HttpException('Too many requests. Please slow down.', HttpStatus.TOO_MANY_REQUESTS)
      );
    });

    it('should return fallback message if LLM fails', async () => {
      mockRedisClient.incr.mockResolvedValue(1);
      mockRedisClient.get.mockResolvedValue(null);
      
      const result = await service.generateResponse(userId, 'force-fail');
      
      expect(result.content).toBe("I'm sorry, I'm having trouble processing your request right now. Please try again in a moment.");
    });
  });
});
