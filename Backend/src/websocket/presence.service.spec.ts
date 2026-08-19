import { Test, TestingModule } from '@nestjs/testing';
import { PresenceService } from './presence.service';
import { RedisService } from '../redis/redis.service';

describe('PresenceService', () => {
  let service: PresenceService;
  let redisService: RedisService;
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [
        PresenceService,
        {
          provide: RedisService,
          useValue: {
            evalScript: jest.fn(),
            client: {
              sAdd: jest.fn(),
              sRem: jest.fn(),
              sCard: jest.fn(),
              del: jest.fn(),
              sMembers: jest.fn(),
              expire: jest.fn(),
              multi: jest.fn(),
              set: jest.fn(),
              get: jest.fn(),
              incr: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    redisService = moduleRef.get(RedisService);
    service = moduleRef.get(PresenceService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  describe('userConnected', () => {
    it('should track socket, mark user online, set version, and heartbeat atomically', async () => {
      const client = redisService.client as any;
      const evalScript = redisService.evalScript as jest.Mock;
      evalScript.mockResolvedValue(1);
      client.set.mockResolvedValue('OK');

      const version = await service.userConnected(
        'user-1',
        'socket-1',
        'corr-1',
      );

      expect(evalScript).toHaveBeenCalledWith(
        expect.any(String),
        [
          'user:user-1:sockets',
          'presence:online',
          'user:user-1:version',
          'user:user-1:heartbeat',
        ],
        ['socket-1', 300, 120, 'user-1', expect.any(String)],
      );
      expect(client.set).toHaveBeenCalledWith(
        'socket:socket-1:lastSeen',
        expect.any(String),
        { EX: 180 },
      );
      expect(version).toBe(1);
    });

    it('should increment version on subsequent connections', async () => {
      const evalScript = redisService.evalScript as jest.Mock;
      evalScript.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
      const client = redisService.client as any;
      client.set.mockResolvedValue('OK');

      await service.userConnected('user-1', 'socket-1');
      await service.userConnected('user-1', 'socket-2');

      expect(evalScript).toHaveBeenCalledTimes(2);
    });
  });

  describe('userDisconnected', () => {
    it('should fully clean up user when no sockets remain', async () => {
      const client = redisService.client as any;
      const evalScript = redisService.evalScript as jest.Mock;
      client.del.mockResolvedValue(1);
      evalScript.mockResolvedValue(1);

      const result = await service.userDisconnected(
        'user-1',
        'socket-1',
        'corr-1',
      );

      expect(client.del).toHaveBeenCalledWith('socket:socket-1:lastSeen');
      expect(evalScript).toHaveBeenCalledWith(
        expect.any(String),
        [
          'user:user-1:sockets',
          'presence:online',
          'user:user-1:version',
          'user:user-1:heartbeat',
          'user:user-1:rooms',
          'user-1',
        ],
        ['socket-1', 300],
      );
      expect(result).toBe(true);
    });

    it('should only remove socket and refresh TTL if other sockets remain', async () => {
      const client = redisService.client as any;
      const evalScript = redisService.evalScript as jest.Mock;
      client.del.mockResolvedValue(1);
      evalScript.mockResolvedValue(0);

      const result = await service.userDisconnected(
        'user-1',
        'socket-1',
        'corr-1',
      );

      expect(client.del).toHaveBeenCalledWith('socket:socket-1:lastSeen');
      expect(evalScript).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        ['socket-1', 300],
      );
      expect(result).toBe(false);
    });
  });

  describe('joinRoom / leaveRoom', () => {
    it('should join room atomically and refresh TTLs', async () => {
      const evalScript = redisService.evalScript as jest.Mock;
      evalScript.mockResolvedValue(1);

      await service.joinRoom('user-1', 'room-1', 'corr-1');

      expect(evalScript).toHaveBeenCalledWith(
        expect.any(String),
        ['user:user-1:rooms', 'room:room-1:users'],
        ['room-1', 'user-1', 3600],
      );
    });

    it('should leave room atomically', async () => {
      const evalScript = redisService.evalScript as jest.Mock;
      evalScript.mockResolvedValue(1);

      await service.leaveRoom('user-1', 'room-1', 'corr-1');

      expect(evalScript).toHaveBeenCalledWith(
        expect.any(String),
        ['user:user-1:rooms', 'room:room-1:users'],
        ['room-1', 'user-1'],
      );
    });
  });

  describe('heartbeat', () => {
    it('should update heartbeat with current timestamp', async () => {
      const client = redisService.client as any;
      client.set.mockResolvedValue('OK');

      await service.heartbeat('user-1');

      expect(client.set).toHaveBeenCalledWith(
        'user:user-1:heartbeat',
        expect.any(String),
        { EX: 120 },
      );
    });
  });

  describe('cleanupStaleUsers', () => {
    it('should remove users with stale or missing heartbeats', async () => {
      const client = redisService.client as any;
      client.sMembers.mockResolvedValue(['user-1', 'user-2', 'user-3']);
      client.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce((Date.now() - 400000).toString())
        .mockResolvedValueOnce((Date.now() - 10000).toString());

      const mockPipeline = {
        sRem: jest.fn().mockReturnThis(),
        del: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      };
      client.multi.mockReturnValue(mockPipeline);

      const stale = await service.cleanupStaleUsers(300);

      expect(stale).toContain('user-1');
      expect(stale).toContain('user-2');
      expect(stale).not.toContain('user-3');
      expect(mockPipeline.sRem).toHaveBeenCalledWith(
        'presence:online',
        'user-1',
      );
      expect(mockPipeline.sRem).toHaveBeenCalledWith(
        'presence:online',
        'user-2',
      );
    });
  });
});
