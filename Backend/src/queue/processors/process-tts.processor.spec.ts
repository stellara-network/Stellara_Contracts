import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { ProcessTtsProcessor } from './process-tts.processor';
import { QueueJobTracingWrapper } from '../../observability/middleware/queue-job-tracing.wrapper';

describe('ProcessTtsProcessor', () => {
  let processor: ProcessTtsProcessor;

  const mockJob = {
    id: '123',
    data: {
      text: 'Hello, this is a test',
      voiceId: 'voice-001',
      language: 'en',
      speed: 1.0,
      sessionId: 'session-123',
    },
    attemptsMade: 1,
    opts: { attempts: 3 },
    progress: jest.fn(),
    queue: { name: 'process-tts' },
  };

  beforeEach(async () => {
    mockJob.progress = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProcessTtsProcessor,
        { provide: getQueueToken('failed-jobs'), useValue: { add: jest.fn() } },
        {
          provide: QueueJobTracingWrapper,
          useValue: {
            wrapProcessor: jest.fn().mockImplementation((fn: any) => fn),
          },
        },
      ],
    }).compile();

    processor = module.get<ProcessTtsProcessor>(ProcessTtsProcessor);
  });

  describe('handleProcessTts', () => {
    it('should successfully process TTS', async () => {
      mockJob.data = {
        text: 'Hello, this is a test',
        voiceId: 'voice-001',
        language: 'en',
        speed: 1.0,
        sessionId: 'session-123',
      };
      const result = await processor.handleProcessTts(mockJob as any);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('audioUrl');
      expect(result.data).toHaveProperty('duration');
      expect(result.data).toHaveProperty('voiceId');
    });

    it('should update progress', async () => {
      mockJob.data = {
        text: 'Hello, this is a test',
        voiceId: 'voice-001',
        language: 'en',
        speed: 1.0,
        sessionId: 'session-123',
      };
      await processor.handleProcessTts(mockJob as any);

      expect(mockJob.progress).toHaveBeenCalledWith(10);
      expect(mockJob.progress).toHaveBeenCalledWith(30);
      expect(mockJob.progress).toHaveBeenCalledWith(50);
      expect(mockJob.progress).toHaveBeenCalledWith(80);
      expect(mockJob.progress).toHaveBeenCalledWith(100);
    });

    it('should throw error if text missing', async () => {
      mockJob.data = {
        text: '',
        voiceId: 'voice-001',
        language: 'en',
        speed: 1.0,
        sessionId: 'session-123',
      };

      await expect(
        processor.handleProcessTts(mockJob as any),
      ).rejects.toThrow();
    });

    it('should throw error if voiceId missing', async () => {
      mockJob.data = {
        text: 'Hello',
        voiceId: '',
        language: 'en',
        speed: 1.0,
        sessionId: 'session-123',
      };

      await expect(
        processor.handleProcessTts(mockJob as any),
      ).rejects.toThrow();
    });

    it('should throw error if text exceeds limit', async () => {
      mockJob.data = {
        text: 'a'.repeat(5001),
        voiceId: 'voice-001',
        language: 'en',
        speed: 1.0,
        sessionId: 'session-123',
      };

      await expect(processor.handleProcessTts(mockJob as any)).rejects.toThrow(
        'Text exceeds maximum length',
      );
    });

    it('should include sessionId in result if provided', async () => {
      mockJob.data = {
        text: 'Hello, this is a test',
        voiceId: 'voice-001',
        language: 'en',
        speed: 1.0,
        sessionId: 'session-123',
      };
      const result = await processor.handleProcessTts(mockJob as any);

      expect(result.data.sessionId).toBe('session-123');
    });

    it('should include language and speed in result', async () => {
      mockJob.data = {
        text: 'Hello, this is a test',
        voiceId: 'voice-001',
        language: 'en',
        speed: 1.0,
        sessionId: 'session-123',
      };
      const result = await processor.handleProcessTts(mockJob as any);

      expect(result.data.language).toBe('en');
      expect(result.data.speed).toBe(1.0);
    });

    it('should generate audioUrl with job id', async () => {
      mockJob.data = {
        text: 'Hello, this is a test',
        voiceId: 'voice-001',
        language: 'en',
        speed: 1.0,
        sessionId: 'session-123',
      };
      const result = await processor.handleProcessTts(mockJob as any);

      expect(result.data.audioUrl).toContain('123');
      expect(result.data.audioUrl).toContain('audio');
    });
  });
});
