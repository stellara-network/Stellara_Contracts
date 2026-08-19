import { Test, TestingModule } from '@nestjs/testing';
import { VoiceGateway } from './voice.gateway';
import {
  VoiceSessionService,
  MAX_SESSIONS_PER_USER,
} from './services/voice-session.service';
import { StreamingResponseService } from './services/streaming-response.service';
import { WebSocketTracingAdapter } from '../observability/middleware/websocket-tracing.adapter';
import { WsJwtAuthGuard } from '../auth/guards/ws-jwt-auth.guard';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { FeatureContext } from './types/feature-context.enum';
import { ConversationState } from './types/conversation-state.enum';

describe('VoiceGateway', () => {
  let gateway: VoiceGateway;
  let voiceSessionService: VoiceSessionService;
  let streamingResponseService: StreamingResponseService;
  let server: Server;
  let client: Socket;

  const mockServer = {
    to: jest.fn().mockReturnThis(),
    emit: jest.fn(),
  } as any;

  const mockClient = {
    id: 'client123',
    handshake: {
      auth: {
        userId: 'user123',
        sessionId: 'session123',
      },
    },
    data: {
      user: { sub: 'user123', userId: 'user123' },
    },
    join: jest.fn(),
    leave: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
  };

  const mockVoiceSessionService = {
    getSession: jest.fn(),
    createSession: jest.fn(),
    updateSessionSocket: jest.fn(),
    updateSessionState: jest.fn(),
    resumeSession: jest.fn(),
    getUserActiveSessions: jest.fn(),
    terminateSession: jest.fn(),
    addMessage: jest.fn(),
    // AC-1: Redis-backed active-session pointer
    setUserActiveSession: jest.fn(),
    getUserActiveSession: jest.fn(),
    deleteUserActiveSession: jest.fn(),
    refreshUserSessionTTL: jest.fn(),
    // AC-2: heartbeat
    updateLastPingAt: jest.fn(),
  };

  const mockStreamingResponseService = {
    startStreamingResponse: jest.fn(),
    interruptStream: jest.fn(),
  };

  const mockWebSocketTracingAdapter = {
    initializeConnection: jest.fn().mockReturnValue({}),
    handleDisconnection: jest.fn(),
    recordMessage: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoiceGateway,
        {
          provide: VoiceSessionService,
          useValue: mockVoiceSessionService,
        },
        {
          provide: StreamingResponseService,
          useValue: mockStreamingResponseService,
        },
        {
          provide: WebSocketTracingAdapter,
          useValue: mockWebSocketTracingAdapter,
        },
        WsJwtAuthGuard,
        {
          provide: JwtService,
          useValue: { verifyAsync: jest.fn(), sign: jest.fn() },
        },
      ],
    }).compile();

    gateway = module.get<VoiceGateway>(VoiceGateway);
    voiceSessionService = module.get<VoiceSessionService>(VoiceSessionService);
    streamingResponseService = module.get<StreamingResponseService>(
      StreamingResponseService,
    );

    gateway['server'] = mockServer;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });

  describe('handleConnection', () => {
    it('should resume existing session on connection and set Redis pointer', async () => {
      const mockSession = {
        id: 'session123',
        userId: 'user123',
        state: ConversationState.IDLE,
      };

      mockVoiceSessionService.getSession.mockResolvedValue(mockSession);
      mockVoiceSessionService.updateSessionSocket.mockResolvedValue(true);
      mockVoiceSessionService.resumeSession.mockResolvedValue(true);
      mockVoiceSessionService.setUserActiveSession.mockResolvedValue(undefined);

      await gateway.handleConnection(mockClient as any);

      expect(mockVoiceSessionService.getSession).toHaveBeenCalledWith(
        'session123',
      );
      expect(mockVoiceSessionService.updateSessionSocket).toHaveBeenCalledWith(
        'session123',
        'client123',
      );
      // AC-1: Redis pointer must be set on reconnect
      expect(mockVoiceSessionService.setUserActiveSession).toHaveBeenCalledWith(
        'user123',
        'session123',
      );
      expect(mockClient.join).toHaveBeenCalledWith('session123');
      expect(mockClient.emit).toHaveBeenCalledWith('voice:resumed', {
        sessionId: 'session123',
        state: ConversationState.IDLE,
      });
    });

    it('should disconnect client with invalid session', async () => {
      mockVoiceSessionService.getSession.mockResolvedValue(null);

      await gateway.handleConnection(mockClient as any);

      expect(mockClient.emit).toHaveBeenCalledWith('voice:error', {
        message: 'Invalid session',
      });
      expect(mockClient.disconnect).toHaveBeenCalled();
    });
  });

  describe('createSession', () => {
    it('should create new session when no active session exists', async () => {
      const createSessionDto = {
        userId: 'user123',
        context: FeatureContext.GENERAL,
      };

      mockVoiceSessionService.getUserActiveSessions.mockResolvedValue([]);
      const mockSession = {
        id: 'newSession123',
        userId: 'user123',
        context: FeatureContext.GENERAL,
        state: ConversationState.IDLE,
      };
      mockVoiceSessionService.createSession.mockResolvedValue(mockSession);
      mockVoiceSessionService.updateSessionSocket.mockResolvedValue(true);
      mockVoiceSessionService.setUserActiveSession.mockResolvedValue(undefined);

      await gateway.createSession(mockClient as any, createSessionDto);

      expect(mockVoiceSessionService.createSession).toHaveBeenCalledWith(
        'user123',
        FeatureContext.GENERAL,
        undefined,
        undefined,
      );
      expect(mockClient.join).toHaveBeenCalledWith('newSession123');
      // AC-1: Redis pointer stored after new session creation
      expect(mockVoiceSessionService.setUserActiveSession).toHaveBeenCalledWith(
        'user123',
        'newSession123',
      );
      expect(mockClient.emit).toHaveBeenCalledWith('voice:session-created', {
        session: mockSession,
      });
    });

    it('should reuse existing session when available', async () => {
      const createSessionDto = {
        userId: 'user123',
        context: FeatureContext.GENERAL,
      };

      const existingSession = {
        id: 'existingSession123',
        userId: 'user123',
        state: ConversationState.LISTENING,
      };

      mockVoiceSessionService.getUserActiveSessions.mockResolvedValue([
        existingSession,
      ]);
      mockVoiceSessionService.updateSessionSocket.mockResolvedValue(true);
      mockVoiceSessionService.setUserActiveSession.mockResolvedValue(undefined);

      await gateway.createSession(mockClient as any, createSessionDto);

      expect(mockVoiceSessionService.createSession).not.toHaveBeenCalled();
      expect(mockClient.join).toHaveBeenCalledWith('existingSession123');
      expect(mockClient.emit).toHaveBeenCalledWith('voice:session-created', {
        session: existingSession,
      });
    });

    // AC-4: session limit enforcement
    it('should emit SESSION_LIMIT_REACHED error when session cap is hit', async () => {
      const createSessionDto = {
        userId: 'user123',
        context: FeatureContext.GENERAL,
      };

      // No existing sessions in getUserActiveSessions (gateway checks this first)
      mockVoiceSessionService.getUserActiveSessions.mockResolvedValue([]);
      // createSession itself throws when the limit is reached
      mockVoiceSessionService.createSession.mockRejectedValue(
        new Error(
          'Session limit reached: users may have at most 3 concurrent sessions',
        ),
      );

      await gateway.createSession(mockClient as any, createSessionDto);

      expect(mockClient.emit).toHaveBeenCalledWith('voice:error', {
        code: 'SESSION_LIMIT_REACHED',
        message: expect.stringContaining('Session limit reached'),
      });
    });
  });

  describe('handleMessage', () => {
    beforeEach(() => {
      // AC-1: gateway now resolves session via Redis
      mockVoiceSessionService.getUserActiveSession.mockResolvedValue(
        'session123',
      );
    });

    it('should start streaming response for valid message', async () => {
      const messageDto = { content: 'Hello AI' };
      const mockSession = {
        id: 'session123',
        userId: 'user123',
      };

      mockVoiceSessionService.getSession.mockResolvedValue(mockSession);
      mockStreamingResponseService.startStreamingResponse.mockResolvedValue(
        'stream123',
      );

      await gateway.handleMessage(mockClient as any, messageDto);

      expect(
        mockStreamingResponseService.startStreamingResponse,
      ).toHaveBeenCalledWith(mockServer, 'session123', 'Hello AI');
    });

    it('should return error for user with no active session', async () => {
      mockVoiceSessionService.getUserActiveSession.mockResolvedValue(null);
      const messageDto = { content: 'Hello AI' };

      await gateway.handleMessage(mockClient as any, messageDto);

      expect(mockClient.emit).toHaveBeenCalledWith('voice:error', {
        message: 'No active session',
      });
      expect(
        mockStreamingResponseService.startStreamingResponse,
      ).not.toHaveBeenCalled();
    });
  });

  describe('handleInterrupt', () => {
    beforeEach(() => {
      mockVoiceSessionService.getUserActiveSession.mockResolvedValue(
        'session123',
      );
    });

    it('should interrupt streaming response', async () => {
      const data = { streamId: 'stream123' };
      mockStreamingResponseService.interruptStream.mockResolvedValue(true);

      await gateway.handleInterrupt(mockClient as any, data);

      expect(mockStreamingResponseService.interruptStream).toHaveBeenCalledWith(
        mockServer,
        'session123',
        'stream123',
      );
      expect(mockClient.emit).toHaveBeenCalledWith(
        'voice:interrupt-acknowledged',
        { sessionId: 'session123', streamId: 'stream123' },
      );
    });

    it('should return error when interrupt fails', async () => {
      const data = { streamId: 'stream123' };
      mockStreamingResponseService.interruptStream.mockResolvedValue(false);

      await gateway.handleInterrupt(mockClient as any, data);

      expect(mockClient.emit).toHaveBeenCalledWith('voice:error', {
        message: 'Failed to interrupt',
      });
    });
  });

  describe('handleTerminate', () => {
    beforeEach(() => {
      mockVoiceSessionService.getUserActiveSession.mockResolvedValue(
        'session123',
      );
    });

    it('should terminate session successfully and clear Redis pointer', async () => {
      mockStreamingResponseService.interruptStream.mockResolvedValue(true);
      mockVoiceSessionService.terminateSession.mockResolvedValue(true);
      mockVoiceSessionService.deleteUserActiveSession.mockResolvedValue(
        undefined,
      );

      await gateway.handleTerminate(mockClient as any);

      expect(mockStreamingResponseService.interruptStream).toHaveBeenCalledWith(
        mockServer,
        'session123',
      );
      expect(mockVoiceSessionService.terminateSession).toHaveBeenCalledWith(
        'session123',
      );
      // AC-1: pointer must be cleared on termination
      expect(
        mockVoiceSessionService.deleteUserActiveSession,
      ).toHaveBeenCalledWith('user123');
      expect(mockClient.leave).toHaveBeenCalledWith('session123');
      expect(mockClient.emit).toHaveBeenCalledWith('voice:terminated', {
        sessionId: 'session123',
      });
    });

    it('should return error when termination fails', async () => {
      mockVoiceSessionService.terminateSession.mockResolvedValue(false);
      mockStreamingResponseService.interruptStream.mockResolvedValue(false);

      await gateway.handleTerminate(mockClient as any);

      expect(mockClient.emit).toHaveBeenCalledWith('voice:error', {
        message: 'Failed to terminate session',
      });
    });
  });

  describe('handlePing', () => {
    beforeEach(() => {
      mockVoiceSessionService.getUserActiveSession.mockResolvedValue(
        'session123',
      );
    });

    it('should update session socket, heartbeat timestamp and refresh TTL, then pong', async () => {
      mockVoiceSessionService.updateSessionSocket.mockResolvedValue(true);
      mockVoiceSessionService.updateLastPingAt.mockResolvedValue(true);
      mockVoiceSessionService.refreshUserSessionTTL.mockResolvedValue(
        undefined,
      );

      await gateway.handlePing(mockClient as any);

      expect(mockVoiceSessionService.updateSessionSocket).toHaveBeenCalledWith(
        'session123',
        'client123',
      );
      // AC-2: heartbeat timestamp updated on every ping
      expect(mockVoiceSessionService.updateLastPingAt).toHaveBeenCalledWith(
        'session123',
      );
      // AC-1: TTL on the active-session pointer refreshed
      expect(
        mockVoiceSessionService.refreshUserSessionTTL,
      ).toHaveBeenCalledWith('user123');
      expect(mockClient.emit).toHaveBeenCalledWith('voice:pong', {
        timestamp: expect.any(Number),
      });
    });

    it('should still send pong even when there is no active session', async () => {
      mockVoiceSessionService.getUserActiveSession.mockResolvedValue(null);

      await gateway.handlePing(mockClient as any);

      expect(
        mockVoiceSessionService.updateSessionSocket,
      ).not.toHaveBeenCalled();
      expect(mockVoiceSessionService.updateLastPingAt).not.toHaveBeenCalled();
      expect(mockClient.emit).toHaveBeenCalledWith('voice:pong', {
        timestamp: expect.any(Number),
      });
    });
  });
});
