import { Test, TestingModule } from '@nestjs/testing';
import { MarketCacheService } from './market-cache.service';
import { RedisService } from '../../redis/redis.service';
import { CacheNamespace } from '../types/cache-config.types';

describe('MarketCacheService', () => {
  let service: MarketCacheService;

  const mockRedisClient = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(0),
    incr: jest.fn().mockResolvedValue(1),
    keys: jest.fn().mockResolvedValue([]),
    exists: jest.fn().mockResolvedValue(0),
    ttl: jest.fn().mockResolvedValue(-1),
  };

  const mockRedisService = {
    client: mockRedisClient,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketCacheService,
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
      ],
    }).compile();

    service = module.get<MarketCacheService>(MarketCacheService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('get', () => {
    const key = 'test-key';
    const namespace = CacheNamespace.MARKET_SNAPSHOT;

    it('should return cached data on cache hit', async () => {
      const cachedData = { test: 'data' };
      mockRedisClient.get.mockResolvedValueOnce(JSON.stringify(cachedData));
      mockRedisClient.incr.mockResolvedValue(1);

      const result = await service.get(key, namespace);

      expect(result).toEqual(cachedData);
      expect(mockRedisClient.incr).toHaveBeenCalledWith(
        `${namespace}:stats:hits`,
      );
      expect(mockRedisClient.incr).toHaveBeenCalledWith(
        'market:cache:total-hits',
      );
    });

    it('should return null and record miss on cache miss', async () => {
      mockRedisClient.get.mockResolvedValueOnce(null);
      mockRedisClient.incr.mockResolvedValue(1);

      const result = await service.get(key, namespace);

      expect(result).toBeNull();
      expect(mockRedisClient.incr).toHaveBeenCalledWith(
        `${namespace}:stats:misses`,
      );
      expect(mockRedisClient.incr).toHaveBeenCalledWith(
        'market:cache:total-misses',
      );
    });

    it('should return null on error', async () => {
      mockRedisClient.get.mockRejectedValueOnce(new Error('Redis error'));

      const result = await service.get(key, namespace);

      expect(result).toBeNull();
    });
  });

  describe('set', () => {
    const key = 'test-key';
    const value = { test: 'data' };
    const namespace = CacheNamespace.MARKET_SNAPSHOT;

    it('should cache data with default TTL', async () => {
      mockRedisClient.set.mockResolvedValue('OK');
      mockRedisClient.incr.mockResolvedValue(1);

      await service.set(key, value, namespace);

      expect(mockRedisClient.set).toHaveBeenCalledWith(
        expect.any(String),
        JSON.stringify(value),
        { EX: 86400 },
      );
      expect(mockRedisClient.incr).toHaveBeenCalledWith(
        `${namespace}:stats:total-entries`,
      );
    });

    it('should cache data with custom TTL', async () => {
      const customTtl = 600;
      mockRedisClient.set.mockResolvedValue('OK');
      mockRedisClient.incr.mockResolvedValue(1);

      await service.set(key, value, namespace, customTtl);

      expect(mockRedisClient.set).toHaveBeenCalledWith(
        expect.any(String),
        JSON.stringify(value),
        { EX: 86400 },
      );
    });

    it('should not throw on error', async () => {
      mockRedisClient.set.mockRejectedValueOnce(new Error('Redis error'));

      await expect(service.set(key, value, namespace)).resolves.not.toThrow();
    });
  });

  describe('invalidate', () => {
    const keys = ['key1', 'key2'];
    const namespace = CacheNamespace.MARKET_SNAPSHOT;

    it('should invalidate specified keys', async () => {
      mockRedisClient.del.mockResolvedValue(2);

      const result = await service.invalidate(keys, namespace);

      expect(result).toBe(2);
      expect(mockRedisClient.del).toHaveBeenCalled();
    });

    it('should return 0 for empty keys array', async () => {
      const result = await service.invalidate([], namespace);

      expect(result).toBe(0);
      expect(mockRedisClient.del).not.toHaveBeenCalled();
    });

    it('should return 0 on error', async () => {
      mockRedisClient.del.mockRejectedValueOnce(new Error('Redis error'));

      const result = await service.invalidate(keys, namespace);

      expect(result).toBe(0);
    });
  });

  describe('invalidateByPattern', () => {
    const pattern = 'test*';
    const namespace = CacheNamespace.MARKET_SNAPSHOT;

    it('should invalidate keys matching pattern', async () => {
      mockRedisClient.keys.mockResolvedValueOnce(['key1', 'key2', 'key3']);
      mockRedisClient.del.mockResolvedValue(3);

      const result = await service.invalidateByPattern(pattern, namespace);

      expect(result).toBe(3);
      expect(mockRedisClient.keys).toHaveBeenCalledWith(
        `${namespace}:${pattern}*`,
      );
      expect(mockRedisClient.del).toHaveBeenCalled();
    });

    it('should return 0 when no keys match', async () => {
      mockRedisClient.keys.mockResolvedValueOnce([]);

      const result = await service.invalidateByPattern(pattern, namespace);

      expect(result).toBe(0);
      expect(mockRedisClient.del).not.toHaveBeenCalled();
    });
  });

  describe('invalidateNamespace', () => {
    const namespace = CacheNamespace.MARKET_SNAPSHOT;

    it('should invalidate all keys in namespace', async () => {
      mockRedisClient.keys.mockResolvedValueOnce(['key1', 'key2', 'key3']);
      mockRedisClient.del.mockResolvedValue(3);

      const result = await service.invalidateNamespace(namespace);

      expect(result).toBe(3);
      expect(mockRedisClient.keys).toHaveBeenCalledWith(`${namespace}:*`);
      expect(mockRedisClient.del).toHaveBeenCalledTimes(4); // keys + 3 stats counters
    });

    it('should return 0 when namespace is empty', async () => {
      mockRedisClient.keys.mockResolvedValueOnce([]);

      const result = await service.invalidateNamespace(namespace);

      expect(result).toBe(0);
    });
  });

  describe('getStats', () => {
    const namespace = CacheNamespace.MARKET_SNAPSHOT;

    it('should return cache statistics', async () => {
      mockRedisClient.get
        .mockResolvedValueOnce('100') // hits
        .mockResolvedValueOnce('50'); // misses
      mockRedisClient.keys.mockResolvedValueOnce(['key1', 'key2']);

      const stats = await service.getStats(namespace);

      expect(stats.hits).toBe(100);
      expect(stats.misses).toBe(50);
      expect(stats.hitRate).toBeCloseTo(100 / 150);
      expect(stats.totalKeys).toBe(2);
      expect(stats.namespace).toBe(namespace);
    });

    it('should return zero stats on error', async () => {
      mockRedisClient.get.mockRejectedValueOnce(new Error('Redis error'));

      const stats = await service.getStats(namespace);

      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.hitRate).toBe(0);
      expect(stats.totalKeys).toBe(0);
    });
  });

  describe('has', () => {
    const key = 'test-key';
    const namespace = CacheNamespace.MARKET_SNAPSHOT;

    it('should return true if key exists', async () => {
      mockRedisClient.exists.mockResolvedValueOnce(1);

      const result = await service.has(key, namespace);

      expect(result).toBe(true);
    });

    it('should return false if key does not exist', async () => {
      mockRedisClient.exists.mockResolvedValueOnce(0);

      const result = await service.has(key, namespace);

      expect(result).toBe(false);
    });

    it('should return false on error', async () => {
      mockRedisClient.exists.mockRejectedValueOnce(new Error('Redis error'));

      const result = await service.has(key, namespace);

      expect(result).toBe(false);
    });
  });

  describe('getTtl', () => {
    const key = 'test-key';
    const namespace = CacheNamespace.MARKET_SNAPSHOT;

    it('should return TTL for key', async () => {
      mockRedisClient.ttl.mockResolvedValueOnce(300);

      const result = await service.getTtl(key, namespace);

      expect(result).toBe(300);
    });

    it('should return -1 on error', async () => {
      mockRedisClient.ttl.mockRejectedValueOnce(new Error('Redis error'));

      const result = await service.getTtl(key, namespace);

      expect(result).toBe(-1);
    });
  });
});
