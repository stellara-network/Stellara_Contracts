import { Test, TestingModule } from '@nestjs/testing';
import {
  VoiceSessionService,
  MAX_SESSIONS_PER_USER,
  HEARTBEAT_TIMEOUT_MS,
} from './services/voice-session.service';
import { ConversationStateMachineService } from './services/conversation-state-machine.service';
import { RedisService } from '../redis/redis.service';
import { FeatureContext } from './types/feature-context.enum';
import { ConversationState } from './types/conversation-state.enum';

describe('VoiceSessionService', () => {
  let service: VoiceSessionService;
  let redisService: RedisService;
  let stateMachine: ConversationStateMachineService;

  const mockRedisService = {
    client: {
      get: jest.fn(),
      setEx: jest.fn(),
      del: jest.fn(),
      sMembers: jest.fn(),
      sAdd: jest.fn(),
      sRem: jest.fn(),
      expire: jest.fn(),
      keys: jest.fn(),
    },
    scanKeys: jest.fn(),
    refreshTTL: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoiceSessionService,
        ConversationStateMachineService,
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
      ],
    }).compile();

    service = module.get<VoiceSessionService>(VoiceSessionService);
    redisService = module.get<RedisService>(RedisService);
    stateMachine = module.get<ConversationStateMachineService>(
      ConversationStateMachineService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createSession', () => {
    it('should create a new voice session', async () => {
      const userId = 'user123';
      const context = FeatureContext.GENERAL;

      mockRedisService.client.sMembers.mockResolvedValue([]);
      mockRedisService.client.setEx.mockResolvedValue('OK');
      mockRedisService.client.sAdd.mockResolvedValue(1);
      mockRedisService.client.expire.mockResolvedValue(1);

      const session = await service.createSession(userId, context);

      expect(session).toBeDefined();
      expect(session.userId).toBe(userId);
      expect(session.context).toBe(context);
      expect(session.state).toBe(ConversationState.IDLE);
      expect(session.messages).toEqual([]);
      expect(mockRedisService.client.setEx).toHaveBeenCalled();
      expect(mockRedisService.client.sAdd).toHaveBeenCalled();
    });

    // AC-4: session limit
    it('should throw when the user has already reached MAX_SESSIONS_PER_USER', async () => {
      const userId = 'user123';
      const context = FeatureContext.GENERAL;

      // Mock MAX_SESSIONS_PER_USER active sessions
      const sessionIds = Array.from(
        { length: MAX_SESSIONS_PER_USER },
        (_, i) => `session${i}`,
      );
      mockRedisService.client.sMembers.mockResolvedValue(sessionIds);

      const makeSession = (id: string) =>
        JSON.stringify({
          id,
          userId,
          context: FeatureContext.GENERAL,
          state: ConversationState.IDLE,
          messages: [],
          createdAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          ttl: 3600,
        });

      mockRedisService.client.get.mockImplementation((key: string) => {
        const id = key.replace('voice:session:', '');
        return Promise.resolve(
          sessionIds.includes(id) ? makeSession(id) : null,
        );
      });

      await expect(service.createSession(userId, context)).rejects.toThrow(
        'Session limit reached',
      );
      expect(mockRedisService.client.setEx).not.toHaveBeenCalled();
    });

    it('should allow creating a session when user has fewer than MAX_SESSIONS_PER_USER sessions', async () => {
      const userId = 'user123';
      const context = FeatureContext.GENERAL;

      // MAX - 1 sessions — still under the cap
      const sessionIds = Array.from(
        { length: MAX_SESSIONS_PER_USER - 1 },
        (_, i) => `session${i}`,
      );
      mockRedisService.client.sMembers.mockResolvedValue(sessionIds);

      const makeSession = (id: string) =>
        JSON.stringify({
          id,
          userId,
          context: FeatureContext.GENERAL,
          state: ConversationState.IDLE,
          messages: [],
          createdAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          ttl: 3600,
        });

      mockRedisService.client.get.mockImplementation((key: string) => {
        const id = key.replace('voice:session:', '');
        return Promise.resolve(
          sessionIds.includes(id) ? makeSession(id) : null,
        );
      });
      mockRedisService.client.setEx.mockResolvedValue('OK');
      mockRedisService.client.sAdd.mockResolvedValue(1);
      mockRedisService.client.expire.mockResolvedValue(1);

      const session = await service.createSession(userId, context);
      expect(session).toBeDefined();
      expect(mockRedisService.client.setEx).toHaveBeenCalled();
    });
  });

  describe('getSession', () => {
    it('should retrieve a session by ID', async () => {
      const sessionId = 'session123';
      const mockSession = {
        id: sessionId,
        userId: 'user123',
        context: FeatureContext.GENERAL,
        state: ConversationState.IDLE,
        messages: [],
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        ttl: 3600,
      };

      mockRedisService.client.get.mockResolvedValue(
        JSON.stringify(mockSession),
      );

      const session = await service.getSession(sessionId);

      expect(session).toBeDefined();
      expect(session?.id).toBe(sessionId);
      expect(session?.userId).toBe('user123');
      expect(mockRedisService.client.get).toHaveBeenCalledWith(
        `voice:session:${sessionId}`,
      );
    });

    it('should return null for non-existent session', async () => {
      mockRedisService.client.get.mockResolvedValue(null);

      const session = await service.getSession('nonexistent');

      expect(session).toBeNull();
    });
  });

  describe('updateSessionState', () => {
    it('should update session state with valid transition', async () => {
      const sessionId = 'session123';
      const mockSession = {
        id: sessionId,
        userId: 'user123',
        context: FeatureContext.GENERAL,
        state: ConversationState.IDLE,
        messages: [],
        createdAt: new Date(),
        lastActivityAt: new Date(),
        ttl: 3600,
      };

      mockRedisService.client.get.mockResolvedValue(
        JSON.stringify(mockSession),
      );
      mockRedisService.client.setEx.mockResolvedValue('OK');

      const result = await service.updateSessionState(
        sessionId,
        ConversationState.LISTENING,
      );

      expect(result).toBe(true);
      expect(mockRedisService.client.setEx).toHaveBeenCalled();
    });

    it('should reject invalid state transition', async () => {
      const sessionId = 'session123';
      const mockSession = {
        id: sessionId,
        userId: 'user123',
        context: FeatureContext.GENERAL,
        state: ConversationState.IDLE,
        messages: [],
        createdAt: new Date(),
        lastActivityAt: new Date(),
        ttl: 3600,
      };

      mockRedisService.client.get.mockResolvedValue(
        JSON.stringify(mockSession),
      );

      const result = await service.updateSessionState(
        sessionId,
        ConversationState.RESPONDING,
      );

      expect(result).toBe(false);
      expect(mockRedisService.client.setEx).not.toHaveBeenCalled();
    });
  });

  describe('addMessage', () => {
    it('should add a message to the session', async () => {
      const sessionId = 'session123';
      const mockSession = {
        id: sessionId,
        userId: 'user123',
        context: FeatureContext.GENERAL,
        state: ConversationState.LISTENING,
        messages: [],
        createdAt: new Date(),
        lastActivityAt: new Date(),
        ttl: 3600,
      };

      mockRedisService.client.get.mockResolvedValue(
        JSON.stringify(mockSession),
      );
      mockRedisService.client.setEx.mockResolvedValue('OK');

      const result = await service.addMessage(sessionId, 'Hello', true);

      expect(result).toBe(true);
      expect(mockRedisService.client.setEx).toHaveBeenCalled();

      // Verify the session was retrieved and updated
      expect(mockRedisService.client.get).toHaveBeenCalledWith(
        'voice:session:session123',
      );
    });
  });

  describe('interruptSession', () => {
    it('should interrupt an interruptible session', async () => {
      const sessionId = 'session123';
      const mockSession = {
        id: sessionId,
        userId: 'user123',
        context: FeatureContext.GENERAL,
        state: ConversationState.RESPONDING,
        messages: [],
        createdAt: new Date(),
        lastActivityAt: new Date(),
        ttl: 3600,
      };

      mockRedisService.client.get.mockResolvedValue(
        JSON.stringify(mockSession),
      );
      mockRedisService.client.setEx.mockResolvedValue('OK');

      const result = await service.interruptSession(sessionId);

      expect(result).toBe(true);
      expect(mockRedisService.client.setEx).toHaveBeenCalled();
    });

    it('should fail to interrupt non-interruptible session', async () => {
      const sessionId = 'session123';
      const mockSession = {
        id: sessionId,
        userId: 'user123',
        context: FeatureContext.GENERAL,
        state: ConversationState.LISTENING,
        messages: [],
        createdAt: new Date(),
        lastActivityAt: new Date(),
        ttl: 3600,
      };

      mockRedisService.client.get.mockResolvedValue(
        JSON.stringify(mockSession),
      );

      const result = await service.interruptSession(sessionId);

      expect(result).toBe(false);
      expect(mockRedisService.client.setEx).not.toHaveBeenCalled();
    });
  });

  describe('terminateSession', () => {
    it('should terminate a session', async () => {
      const sessionId = 'session123';
      const mockSession = {
        id: sessionId,
        userId: 'user123',
        context: FeatureContext.GENERAL,
        state: ConversationState.IDLE,
        messages: [],
        createdAt: new Date(),
        lastActivityAt: new Date(),
        ttl: 3600,
      };

      mockRedisService.client.get.mockResolvedValue(
        JSON.stringify(mockSession),
      );
      mockRedisService.client.del.mockResolvedValue(1);
      mockRedisService.client.sRem.mockResolvedValue(1);

      const result = await service.terminateSession(sessionId);

      expect(result).toBe(true);
      expect(mockRedisService.client.del).toHaveBeenCalledWith(
        `voice:session:${sessionId}`,
      );
      expect(mockRedisService.client.sRem).toHaveBeenCalled();
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('should clean up expired sessions', async () => {
      const expiredSession = {
        id: 'expired123',
        userId: 'user123',
        context: FeatureContext.GENERAL,
        state: ConversationState.IDLE,
        messages: [],
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
        lastActivityAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
        ttl: 3600, // 1 hour TTL
      };

      mockRedisService.scanKeys.mockResolvedValue(['voice:session:expired123']);
      mockRedisService.client.get.mockResolvedValue(
        JSON.stringify(expiredSession),
      );
      mockRedisService.client.del.mockResolvedValue(1);
      mockRedisService.client.sRem.mockResolvedValue(1);

      const cleanedCount = await service.cleanupExpiredSessions();

      expect(cleanedCount).toBe(1);
      expect(mockRedisService.client.del).toHaveBeenCalled();
    });
  });

  // AC-2 + AC-5: stale session cleanup based on heartbeat timeout
  describe('cleanupStaleSessions', () => {
    it('should terminate sessions whose lastPingAt exceeds HEARTBEAT_TIMEOUT_MS', async () => {
      const staleSession = {
        id: 'stale123',
        userId: 'user123',
        context: FeatureContext.GENERAL,
        state: ConversationState.IDLE,
        messages: [],
        createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        lastActivityAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        // lastPingAt is 90 seconds ago — exceeds the 60s threshold
        lastPingAt: new Date(
          Date.now() - HEARTBEAT_TIMEOUT_MS - 30_000,
        ).toISOString(),
        ttl: 3600,
      };

      mockRedisService.scanKeys.mockResolvedValue(['voice:session:stale123']);
      mockRedisService.client.get
        // First call: scanning
        .mockResolvedValueOnce(JSON.stringify(staleSession))
        // Second call: terminateSession -> getSession
        .mockResolvedValueOnce(JSON.stringify(staleSession));
      mockRedisService.client.del.mockResolvedValue(1);
      mockRedisService.client.sRem.mockResolvedValue(1);

      const cleanedCount = await service.cleanupStaleSessions();

      expect(cleanedCount).toBe(1);
      expect(mockRedisService.client.del).toHaveBeenCalledWith(
        'voice:session:stale123',
      );
    });

    it('should not terminate sessions whose lastPingAt is within HEARTBEAT_TIMEOUT_MS', async () => {
      const freshSession = {
        id: 'fresh123',
        userId: 'user123',
        context: FeatureContext.GENERAL,
        state: ConversationState.IDLE,
        messages: [],
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        // lastPingAt is only 10 seconds ago — well within the 60s window
        lastPingAt: new Date(Date.now() - 10_000).toISOString(),
        ttl: 3600,
      };

      mockRedisService.scanKeys.mockResolvedValue(['voice:session:fresh123']);
      mockRedisService.client.get.mockResolvedValue(
        JSON.stringify(freshSession),
      );

      const cleanedCount = await service.cleanupStaleSessions();

      expect(cleanedCount).toBe(0);
      expect(mockRedisService.client.del).not.toHaveBeenCalled();
    });

    it('should skip sessions already marked as STALE or TERMINATED', async () => {
      const alreadyStaleSession = {
        id: 'already-stale',
        userId: 'user123',
        context: FeatureContext.GENERAL,
        state: ConversationState.STALE,
        messages: [],
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        lastActivityAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        lastPingAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        ttl: 3600,
      };

      mockRedisService.scanKeys.mockResolvedValue([
        'voice:session:already-stale',
      ]);
      mockRedisService.client.get.mockResolvedValue(
        JSON.stringify(alreadyStaleSession),
      );

      const cleanedCount = await service.cleanupStaleSessions();

      expect(cleanedCount).toBe(0);
      expect(mockRedisService.client.del).not.toHaveBeenCalled();
    });

    it('should use createdAt as fallback when lastPingAt is absent and session is old', async () => {
      const noPingSession = {
        id: 'noping123',
        userId: 'user123',
        context: FeatureContext.GENERAL,
        state: ConversationState.IDLE,
        messages: [],
        // No lastPingAt — createdAt is 90s ago, which exceeds the 60s threshold
        createdAt: new Date(
          Date.now() - HEARTBEAT_TIMEOUT_MS - 30_000,
        ).toISOString(),
        lastActivityAt: new Date(
          Date.now() - HEARTBEAT_TIMEOUT_MS - 30_000,
        ).toISOString(),
        ttl: 3600,
      };

      mockRedisService.scanKeys.mockResolvedValue(['voice:session:noping123']);
      mockRedisService.client.get
        .mockResolvedValueOnce(JSON.stringify(noPingSession))
        .mockResolvedValueOnce(JSON.stringify(noPingSession));
      mockRedisService.client.del.mockResolvedValue(1);
      mockRedisService.client.sRem.mockResolvedValue(1);

      const cleanedCount = await service.cleanupStaleSessions();

      expect(cleanedCount).toBe(1);
    });
  });

  // AC-1: Redis-backed active-session pointer
  describe('setUserActiveSession / getUserActiveSession / deleteUserActiveSession', () => {
    it('should store and retrieve the active session pointer', async () => {
      mockRedisService.client.setEx.mockResolvedValue('OK');
      await service.setUserActiveSession('user1', 'sess1');
      expect(mockRedisService.client.setEx).toHaveBeenCalledWith(
        'voice:usersession:user1',
        600,
        'sess1',
      );

      mockRedisService.client.get.mockResolvedValue('sess1');
      const result = await service.getUserActiveSession('user1');
      expect(result).toBe('sess1');
    });

    it('should delete the active session pointer', async () => {
      mockRedisService.client.del.mockResolvedValue(1);
      await service.deleteUserActiveSession('user1');
      expect(mockRedisService.client.del).toHaveBeenCalledWith(
        'voice:usersession:user1',
      );
    });
  });

  // AC-2: heartbeat tracking
  describe('updateLastPingAt', () => {
    it('should update lastPingAt on the session', async () => {
      const sessionId = 'session123';
      const mockSession = {
        id: sessionId,
        userId: 'user123',
        context: FeatureContext.GENERAL,
        state: ConversationState.IDLE,
        messages: [],
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        ttl: 3600,
      };

      mockRedisService.client.get.mockResolvedValue(
        JSON.stringify(mockSession),
      );
      mockRedisService.client.setEx.mockResolvedValue('OK');

      const result = await service.updateLastPingAt(sessionId);

      expect(result).toBe(true);
      const savedCall = mockRedisService.client.setEx.mock.calls[0];
      const saved = JSON.parse(savedCall[2]);
      expect(saved.lastPingAt).toBeDefined();
    });
  });
});
