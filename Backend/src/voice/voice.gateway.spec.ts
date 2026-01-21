import { Test, TestingModule } from '@nestjs/testing';
import { VoiceGateway } from './voice.gateway';
import { VoiceSessionService } from './services/voice-session.service';
import { StreamingResponseService } from './services/streaming-response.service';
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
  };

  const mockStreamingResponseService = {
    startStreamingResponse: jest.fn(),
    interruptStream: jest.fn(),
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
      ],
    }).compile();

    gateway = module.get<VoiceGateway>(VoiceGateway);
    voiceSessionService = module.get<VoiceSessionService>(VoiceSessionService);
    streamingResponseService = module.get<StreamingResponseService>(StreamingResponseService);
    
    gateway['server'] = mockServer;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });

  describe('handleConnection', () => {
    it('should resume existing session on connection', async () => {
      const mockSession = {
        id: 'session123',
        userId: 'user123',
        state: ConversationState.IDLE,
      };

      mockVoiceSessionService.getSession.mockResolvedValue(mockSession);
      mockVoiceSessionService.updateSessionSocket.mockResolvedValue(true);
      mockVoiceSessionService.resumeSession.mockResolvedValue(true);

      await gateway.handleConnection(mockClient as any);

      expect(mockVoiceSessionService.getSession).toHaveBeenCalledWith('session123');
      expect(mockVoiceSessionService.updateSessionSocket).toHaveBeenCalledWith('session123', 'client123');
      expect(mockClient.join).toHaveBeenCalledWith('session123');
      expect(mockClient.emit).toHaveBeenCalledWith('voice:resumed', { sessionId: 'session123', state: ConversationState.IDLE });
    });

    it('should disconnect client with invalid session', async () => {
      mockVoiceSessionService.getSession.mockResolvedValue(null);

      await gateway.handleConnection(mockClient as any);

      expect(mockClient.emit).toHaveBeenCalledWith('voice:error', { message: 'Invalid session' });
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

      await gateway.createSession(mockClient as any, createSessionDto);

      expect(mockVoiceSessionService.createSession).toHaveBeenCalledWith('user123', FeatureContext.GENERAL, undefined, undefined);
      expect(mockClient.join).toHaveBeenCalledWith('newSession123');
      expect(mockClient.emit).toHaveBeenCalledWith('voice:session-created', { session: mockSession });
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

      mockVoiceSessionService.getUserActiveSessions.mockResolvedValue([existingSession]);
      mockVoiceSessionService.updateSessionSocket.mockResolvedValue(true);

      await gateway.createSession(mockClient as any, createSessionDto);

      expect(mockVoiceSessionService.createSession).not.toHaveBeenCalled();
      expect(mockClient.join).toHaveBeenCalledWith('existingSession123');
      expect(mockClient.emit).toHaveBeenCalledWith('voice:session-created', { session: existingSession });
    });
  });

  describe('handleMessage', () => {
    beforeEach(() => {
      gateway['userSessions'].set('user123', 'session123');
    });

    it('should start streaming response for valid message', async () => {
      const messageDto = { content: 'Hello AI' };
      const mockSession = {
        id: 'session123',
        userId: 'user123',
      };

      mockVoiceSessionService.getSession.mockResolvedValue(mockSession);
      mockStreamingResponseService.startStreamingResponse.mockResolvedValue('stream123');

      await gateway.handleMessage(mockClient as any, messageDto);

      expect(mockStreamingResponseService.startStreamingResponse).toHaveBeenCalledWith(
        mockServer,
        'session123',
        'Hello AI'
      );
    });

    it('should return error for user with no active session', async () => {
      gateway['userSessions'].delete('user123');
      const messageDto = { content: 'Hello AI' };

      await gateway.handleMessage(mockClient as any, messageDto);

      expect(mockClient.emit).toHaveBeenCalledWith('voice:error', { message: 'No active session' });
      expect(mockStreamingResponseService.startStreamingResponse).not.toHaveBeenCalled();
    });
  });

  describe('handleInterrupt', () => {
    beforeEach(() => {
      gateway['userSessions'].set('user123', 'session123');
    });

    it('should interrupt streaming response', async () => {
      const data = { streamId: 'stream123' };
      mockStreamingResponseService.interruptStream.mockResolvedValue(true);

      await gateway.handleInterrupt(mockClient as any, data);

      expect(mockStreamingResponseService.interruptStream).toHaveBeenCalledWith(
        mockServer,
        'session123',
        'stream123'
      );
      expect(mockClient.emit).toHaveBeenCalledWith('voice:interrupt-acknowledged', { sessionId: 'session123', streamId: 'stream123' });
    });

    it('should return error when interrupt fails', async () => {
      const data = { streamId: 'stream123' };
      mockStreamingResponseService.interruptStream.mockResolvedValue(false);

      await gateway.handleInterrupt(mockClient as any, data);

      expect(mockClient.emit).toHaveBeenCalledWith('voice:error', { message: 'Failed to interrupt' });
    });
  });

  describe('handleTerminate', () => {
    beforeEach(() => {
      gateway['userSessions'].set('user123', 'session123');
    });

    it('should terminate session successfully', async () => {
      mockStreamingResponseService.interruptStream.mockResolvedValue(true);
      mockVoiceSessionService.terminateSession.mockResolvedValue(true);

      await gateway.handleTerminate(mockClient as any);

      expect(mockStreamingResponseService.interruptStream).toHaveBeenCalledWith(mockServer, 'session123');
      expect(mockVoiceSessionService.terminateSession).toHaveBeenCalledWith('session123');
      expect(mockClient.leave).toHaveBeenCalledWith('session123');
      expect(mockClient.emit).toHaveBeenCalledWith('voice:terminated', { sessionId: 'session123' });
    });

    it('should return error when termination fails', async () => {
      mockVoiceSessionService.terminateSession.mockResolvedValue(false);

      await gateway.handleTerminate(mockClient as any);

      expect(mockClient.emit).toHaveBeenCalledWith('voice:error', { message: 'Failed to terminate session' });
    });
  });

  describe('handlePing', () => {
    beforeEach(() => {
      gateway['userSessions'].set('user123', 'session123');
    });

    it('should update session activity and respond with pong', async () => {
      mockVoiceSessionService.updateSessionSocket.mockResolvedValue(true);

      await gateway.handlePing(mockClient as any);

      expect(mockVoiceSessionService.updateSessionSocket).toHaveBeenCalledWith('session123', 'client123');
      expect(mockClient.emit).toHaveBeenCalledWith('voice:pong', { timestamp: expect.any(Number) });
    });
  });
});
