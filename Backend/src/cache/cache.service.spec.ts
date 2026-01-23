import { Test, TestingModule } from '@nestjs/testing';
import { CacheService, CacheMetrics } from './cache.service';
import { RedisService } from '../redis/redis.service';

describe('CacheService', () => {
  let service: CacheService;
  let redisService: RedisService;
  let mockRedisClient: any;

  beforeEach(async () => {
    // Mock Redis client
    mockRedisClient = {
      get: jest.fn(),
      set: jest.fn(),
      setEx: jest.fn(),
      del: jest.fn(),
      keys: jest.fn(),
      info: jest.fn(),
    };

    const mockRedisService = {
      client: mockRedisClient,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CacheService,
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
      ],
    }).compile();

    service = module.get<CacheService>(CacheService);
    redisService = module.get<RedisService>(RedisService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('get', () => {
    it('should retrieve a cached value', async () => {
      const key = 'cache:market:snapshot:USD-STELLARA';
      const value = { price: 100, volume: 1000 };

      mockRedisClient.get.mockResolvedValue(JSON.stringify(value));

      const result = await service.get(key);

      expect(result).toEqual(value);
      expect(mockRedisClient.get).toHaveBeenCalledWith(key);
    });

    it('should return null if key does not exist', async () => {
      const key = 'cache:market:snapshot:USD-STELLARA';

      mockRedisClient.get.mockResolvedValue(null);

      const result = await service.get(key);

      expect(result).toBeNull();
    });

    it('should record cache hit on successful retrieval', async () => {
      const key = 'cache:market:snapshot:USD-STELLARA';
      const value = { price: 100 };

      mockRedisClient.get.mockResolvedValue(JSON.stringify(value));

      await service.get(key);
      const metrics = service.getMetrics();

      expect(metrics['cache:market']).toBeDefined();
      expect(metrics['cache:market'].hits).toBe(1);
    });

    it('should record cache miss when key not found', async () => {
      const key = 'cache:market:snapshot:USD-STELLARA';

      mockRedisClient.get.mockResolvedValue(null);

      await service.get(key);
      const metrics = service.getMetrics();

      expect(metrics['cache:market']).toBeDefined();
      expect(metrics['cache:market'].misses).toBe(1);
    });

    it('should handle Redis errors gracefully', async () => {
      const key = 'cache:market:snapshot:USD-STELLARA';

      mockRedisClient.get.mockRejectedValue(new Error('Redis error'));

      const result = await service.get(key);

      expect(result).toBeNull();
      const metrics = service.getMetrics();
      expect(metrics['cache:market'].misses).toBe(1);
    });
  });

  describe('set', () => {
    it('should store value with TTL', async () => {
      const key = 'cache:market:snapshot:USD-STELLARA';
      const value = { price: 100, volume: 1000 };
      const ttl = 60;

      await service.set(key, value, ttl);

      expect(mockRedisClient.setEx).toHaveBeenCalledWith(
        key,
        ttl,
        JSON.stringify(value),
      );
    });

    it('should store value without TTL when ttl is 0', async () => {
      const key = 'cache:market:snapshot:USD-STELLARA';
      const value = { price: 100 };

      await service.set(key, value, 0);

      expect(mockRedisClient.set).toHaveBeenCalledWith(
        key,
        JSON.stringify(value),
      );
    });

    it('should use default TTL from config when not specified', async () => {
      const key = 'cache:market:snapshot:USD-STELLARA';
      const value = { price: 100 };

      await service.set(key, value);

      expect(mockRedisClient.setEx).toHaveBeenCalled();
    });

    it('should handle Redis errors gracefully', async () => {
      const key = 'cache:market:snapshot:USD-STELLARA';
      const value = { price: 100 };

      mockRedisClient.setEx.mockRejectedValue(new Error('Redis error'));

      await service.set(key, value, 60);

      expect(mockRedisClient.setEx).toHaveBeenCalled();
    });
  });

  describe('getOrSet', () => {
    it('should return cached value if present', async () => {
      const key = 'cache:market:snapshot:USD-STELLARA';
      const cachedValue = { price: 100, cached: true };
      const providerValue = { price: 200, cached: false };

      mockRedisClient.get.mockResolvedValue(JSON.stringify(cachedValue));

      const provider = jest.fn().mockResolvedValue(providerValue);

      const result = await service.getOrSet(key, provider);

      expect(result).toEqual(cachedValue);
      expect(provider).not.toHaveBeenCalled();
    });

    it('should call provider and cache value if not in cache', async () => {
      const key = 'cache:market:snapshot:USD-STELLARA';
      const value = { price: 100, volume: 1000 };

      mockRedisClient.get.mockResolvedValue(null);
      mockRedisClient.setEx.mockResolvedValue(true);

      const provider = jest.fn().mockResolvedValue(value);

      const result = await service.getOrSet(key, provider);

      expect(result).toEqual(value);
      expect(provider).toHaveBeenCalled();
      expect(mockRedisClient.setEx).toHaveBeenCalled();
    });

    it('should use custom TTL when provided', async () => {
      const key = 'cache:market:snapshot:USD-STELLARA';
      const value = { price: 100 };
      const customTtl = 120;

      mockRedisClient.get.mockResolvedValue(null);
      mockRedisClient.setEx.mockResolvedValue(true);

      const provider = jest.fn().mockResolvedValue(value);

      await service.getOrSet(key, provider, customTtl);

      expect(mockRedisClient.setEx).toHaveBeenCalledWith(
        key,
        customTtl,
        JSON.stringify(value),
      );
    });

    it('should propagate provider errors', async () => {
      const key = 'cache:market:snapshot:USD-STELLARA';
      const error = new Error('Provider error');

      mockRedisClient.get.mockResolvedValue(null);

      const provider = jest.fn().mockRejectedValue(error);

      await expect(service.getOrSet(key, provider)).rejects.toThrow(error);
    });
  });

  describe('delete', () => {
    it('should delete a cache key', async () => {
      const key = 'cache:market:snapshot:USD-STELLARA';

      mockRedisClient.del.mockResolvedValue(1);

      await service.delete(key);

      expect(mockRedisClient.del).toHaveBeenCalledWith(key);
    });

    it('should handle Redis errors gracefully', async () => {
      const key = 'cache:market:snapshot:USD-STELLARA';

      mockRedisClient.del.mockRejectedValue(new Error('Redis error'));

      await service.delete(key);

      expect(mockRedisClient.del).toHaveBeenCalled();
    });
  });

  describe('deleteByPattern', () => {
    it('should delete multiple keys matching pattern', async () => {
      const pattern = 'cache:market:snapshot:*';
      const keys = [
        'cache:market:snapshot:USD-STELLARA',
        'cache:market:snapshot:EUR-STELLARA',
      ];

      mockRedisClient.keys.mockResolvedValue(keys);
      mockRedisClient.del.mockResolvedValue(2);

      const result = await service.deleteByPattern(pattern);

      expect(result).toBe(2);
      expect(mockRedisClient.keys).toHaveBeenCalledWith(pattern);
      expect(mockRedisClient.del).toHaveBeenCalledWith(keys);
    });

    it('should return 0 if no keys match pattern', async () => {
      const pattern = 'cache:market:snapshot:*';

      mockRedisClient.keys.mockResolvedValue([]);

      const result = await service.deleteByPattern(pattern);

      expect(result).toBe(0);
    });

    it('should handle Redis errors gracefully', async () => {
      const pattern = 'cache:market:snapshot:*';

      mockRedisClient.keys.mockRejectedValue(new Error('Redis error'));

      const result = await service.deleteByPattern(pattern);

      expect(result).toBe(0);
    });
  });

  describe('getMetrics', () => {
    it('should return cache metrics with correct hit rate', async () => {
      const key = 'cache:market:snapshot:USD-STELLARA';
      const value = { price: 100 };

      mockRedisClient.get.mockResolvedValue(JSON.stringify(value));

      // Simulate 3 hits and 1 miss
      await service.get(key);
      await service.get(key);
      await service.get(key);

      mockRedisClient.get.mockResolvedValue(null);
      await service.get(key);

      const metrics = service.getMetrics();

      expect(metrics['cache:market']).toBeDefined();
      expect(metrics['cache:market'].hits).toBe(3);
      expect(metrics['cache:market'].misses).toBe(1);
      expect(metrics['cache:market'].totalRequests).toBe(4);
      expect(metrics['cache:market'].hitRate).toBe(75);
    });
  });

  describe('clearMetrics', () => {
    it('should reset all metrics', async () => {
      const key = 'cache:market:snapshot:USD-STELLARA';
      const value = { price: 100 };

      mockRedisClient.get.mockResolvedValue(JSON.stringify(value));
      await service.get(key);

      let metrics = service.getMetrics();
      expect(metrics['cache:market'].hits).toBe(1);

      await service.clearMetrics();

      metrics = service.getMetrics();
      expect(metrics['cache:market'].hits).toBe(0);
      expect(metrics['cache:market'].misses).toBe(0);
    });
  });

  describe('invalidateEntityCache', () => {
    it('should invalidate cache for specific entity', async () => {
      const entityType = 'asset';
      const entityId = 'STELLARA-USD';

      mockRedisClient.keys.mockResolvedValue([
        'cache:market:snapshot:asset:STELLARA-USD:price',
        'cache:market:snapshot:asset:STELLARA-USD:volume',
      ]);
      mockRedisClient.del.mockResolvedValue(2);

      await service.invalidateEntityCache(entityType, entityId);

      expect(mockRedisClient.keys).toHaveBeenCalled();
      expect(mockRedisClient.del).toHaveBeenCalled();
    });
  });

  describe('getRedisInfo', () => {
    it('should return Redis info', async () => {
      const info = 'redis_version:7.0.0';

      mockRedisClient.info.mockResolvedValue(info);

      const result = await service.getRedisInfo();

      expect(result).toBe(info);
      expect(mockRedisClient.info).toHaveBeenCalled();
    });

    it('should handle Redis errors gracefully', async () => {
      mockRedisClient.info.mockRejectedValue(new Error('Redis error'));

      const result = await service.getRedisInfo();

      expect(result).toBe('Unable to fetch Redis info');
    });
  });
});
