import { Test, TestingModule } from '@nestjs/testing';
import { StreamingResponseService } from './services/streaming-response.service';
import { VoiceSessionService } from './services/voice-session.service';
import { LlmService } from './services/llm.service';
import { Server } from 'socket.io';
import { FeatureContext } from './types/feature-context.enum';
import { ConversationState } from './types/conversation-state.enum';

describe('StreamingResponseService', () => {
  let service: StreamingResponseService;
  let voiceSessionService: VoiceSessionService;
  let llmService: LlmService;
  let server: Server;

  const mockServer = {
    to: jest.fn().mockReturnThis(),
    emit: jest.fn(),
  } as any;

  const mockVoiceSessionService = {
    getSession: jest.fn(),
    updateSessionState: jest.fn(),
    addMessage: jest.fn(),
    interruptSession: jest.fn(),
  };

  const mockLlmService = {
    generateResponse: jest.fn().mockResolvedValue({ content: 'Mock response', cached: false }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StreamingResponseService,
        {
          provide: VoiceSessionService,
          useValue: mockVoiceSessionService,
        },
        {
          provide: LlmService,
          useValue: mockLlmService,
        },
      ],
    }).compile();

    service = module.get<StreamingResponseService>(StreamingResponseService);
    voiceSessionService = module.get<VoiceSessionService>(VoiceSessionService);
    llmService = module.get<LlmService>(LlmService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('startStreamingResponse', () => {
    it('should start streaming response for valid session', async () => {
      const sessionId = 'session123';
      const userMessage = 'Hello AI';
      const mockSession = {
        id: sessionId,
        userId: 'user123',
        context: FeatureContext.GENERAL,
        state: ConversationState.LISTENING,
        socketId: 'socket123',
      };

      mockVoiceSessionService.getSession.mockResolvedValue(mockSession);
      mockVoiceSessionService.addMessage.mockResolvedValue(true);
      mockVoiceSessionService.updateSessionState.mockResolvedValue(true);

      const streamId = await service.startStreamingResponse(mockServer, sessionId, userMessage);

      expect(streamId).toBeDefined();
      expect(mockVoiceSessionService.addMessage).toHaveBeenCalledWith(sessionId, userMessage, true);
      expect(mockVoiceSessionService.updateSessionState).toHaveBeenCalledWith(sessionId, ConversationState.THINKING);
      expect(mockServer.to).toHaveBeenCalledWith('socket123');
      expect(mockServer.emit).toHaveBeenCalledWith('voice:thinking', { sessionId, streamId });
    });

    it('should throw error for non-existent session', async () => {
      mockVoiceSessionService.getSession.mockResolvedValue(null);

      await expect(service.startStreamingResponse(mockServer, 'nonexistent', 'Hello'))
        .rejects.toThrow('Session nonexistent not found');
    });
  });

  describe('interruptStream', () => {
    it('should interrupt specific stream', async () => {
      const sessionId = 'session123';
      const streamId = 'stream123';
      const mockSession = {
        id: sessionId,
        userId: 'user123',
        socketId: 'socket123',
      };

      mockVoiceSessionService.getSession.mockResolvedValue(mockSession);
      mockVoiceSessionService.interruptSession.mockResolvedValue(true);

      // First, start a stream
      mockVoiceSessionService.addMessage.mockResolvedValue(true);
      mockVoiceSessionService.updateSessionState.mockResolvedValue(true);
      await service.startStreamingResponse(mockServer, sessionId, 'Hello');

      const success = await service.interruptStream(mockServer, sessionId, streamId);

      expect(success).toBe(true);
      expect(mockVoiceSessionService.interruptSession).toHaveBeenCalledWith(sessionId);
      expect(mockServer.to).toHaveBeenCalledWith('socket123');
    });

    it('should interrupt all streams for session when no streamId provided', async () => {
      const sessionId = 'session123';
      const mockSession = {
        id: sessionId,
        userId: 'user123',
        socketId: 'socket123',
      };

      mockVoiceSessionService.getSession.mockResolvedValue(mockSession);
      mockVoiceSessionService.interruptSession.mockResolvedValue(true);

      const success = await service.interruptStream(mockServer, sessionId);

      expect(success).toBe(true);
      expect(mockVoiceSessionService.interruptSession).toHaveBeenCalledWith(sessionId);
    });

    it('should return false for non-existent session', async () => {
      mockVoiceSessionService.getSession.mockResolvedValue(null);

      const success = await service.interruptStream(mockServer, 'nonexistent', 'stream123');

      expect(success).toBe(false);
    });
  });

  describe('getActiveStreamCount', () => {
    it('should return 0 when no streams are active', () => {
      const count = service.getActiveStreamCount();
      expect(count).toBe(0);
    });

    it('should return correct count when streams are active', async () => {
      const sessionId = 'session123';
      const mockSession = {
        id: sessionId,
        userId: 'user123',
        socketId: 'socket123',
      };

      mockVoiceSessionService.getSession.mockResolvedValue(mockSession);
      mockVoiceSessionService.addMessage.mockResolvedValue(true);
      mockVoiceSessionService.updateSessionState.mockResolvedValue(true);

      await service.startStreamingResponse(mockServer, sessionId, 'Hello');
      await service.startStreamingResponse(mockServer, sessionId, 'Hello again');

      const count = service.getActiveStreamCount();
      expect(count).toBe(2);
    });
  });

  describe('getActiveStreamsForSession', () => {
    it('should return empty array for session with no active streams', () => {
      const streams = service.getActiveStreamsForSession('session123');
      expect(streams).toEqual([]);
    });

    it('should return active streams for session', async () => {
      const sessionId = 'session123';
      const mockSession = {
        id: sessionId,
        userId: 'user123',
        socketId: 'socket123',
      };

      mockVoiceSessionService.getSession.mockResolvedValue(mockSession);
      mockVoiceSessionService.addMessage.mockResolvedValue(true);
      mockVoiceSessionService.updateSessionState.mockResolvedValue(true);

      await service.startStreamingResponse(mockServer, sessionId, 'Hello');

      const streams = service.getActiveStreamsForSession(sessionId);
      expect(streams).toHaveLength(1);
      expect(streams[0].sessionId).toBe(sessionId);
    });
  });
});
