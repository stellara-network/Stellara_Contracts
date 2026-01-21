import { Test, TestingModule } from '@nestjs/testing';
import { VoiceSessionService } from './services/voice-session.service';
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
    stateMachine = module.get<ConversationStateMachineService>(ConversationStateMachineService);
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

      mockRedisService.client.get.mockResolvedValue(JSON.stringify(mockSession));

      const session = await service.getSession(sessionId);

      expect(session).toBeDefined();
      expect(session?.id).toBe(sessionId);
      expect(session?.userId).toBe('user123');
      expect(mockRedisService.client.get).toHaveBeenCalledWith(`voice:session:${sessionId}`);
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

      mockRedisService.client.get.mockResolvedValue(JSON.stringify(mockSession));
      mockRedisService.client.setEx.mockResolvedValue('OK');

      const result = await service.updateSessionState(sessionId, ConversationState.LISTENING);

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

      mockRedisService.client.get.mockResolvedValue(JSON.stringify(mockSession));

      const result = await service.updateSessionState(sessionId, ConversationState.RESPONDING);

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

      mockRedisService.client.get.mockResolvedValue(JSON.stringify(mockSession));
      mockRedisService.client.setEx.mockResolvedValue('OK');

      const result = await service.addMessage(sessionId, 'Hello', true);

      expect(result).toBe(true);
      expect(mockRedisService.client.setEx).toHaveBeenCalled();
      
      // Verify the session was retrieved and updated
      expect(mockRedisService.client.get).toHaveBeenCalledWith('voice:session:session123');
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

      mockRedisService.client.get.mockResolvedValue(JSON.stringify(mockSession));
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

      mockRedisService.client.get.mockResolvedValue(JSON.stringify(mockSession));

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

      mockRedisService.client.get.mockResolvedValue(JSON.stringify(mockSession));
      mockRedisService.client.del.mockResolvedValue(1);
      mockRedisService.client.sRem.mockResolvedValue(1);

      const result = await service.terminateSession(sessionId);

      expect(result).toBe(true);
      expect(mockRedisService.client.del).toHaveBeenCalledWith(`voice:session:${sessionId}`);
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

      mockRedisService.client.keys.mockResolvedValue(['voice:session:expired123']);
      mockRedisService.client.get.mockResolvedValue(JSON.stringify(expiredSession));
      mockRedisService.client.del.mockResolvedValue(1);
      mockRedisService.client.sRem.mockResolvedValue(1);

      const cleanedCount = await service.cleanupExpiredSessions();

      expect(cleanedCount).toBe(1);
      expect(mockRedisService.client.del).toHaveBeenCalled();
    });
  });
});
