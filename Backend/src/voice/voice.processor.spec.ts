import { Test, TestingModule } from '@nestjs/testing';
import { VoiceProcessor } from './voice.processor';
import { VoiceService } from './services/voice.service';
import { VoiceProviderService } from './providers/voice-provider.service';
import { MetricsService } from '../observability/services/metrics.service';
import { LoggingService } from '../observability/services/logging.service';
import { JobStatus, JobType, VoiceJob } from './entities/voice-job.entity';
import { VoiceJobStage } from './types/voice-job-stage.enum';
import {
  VoiceErrorCode,
  transientProviderFailure,
  validationFailure,
} from './types/voice-errors';

const makeJob = (overrides: Partial<VoiceJob> = {}): VoiceJob =>
  ({
    id: 'job-123',
    type: JobType.STT,
    status: JobStatus.PENDING,
    stage: VoiceJobStage.QUEUED,
    progress: 30,
    retryCount: 0,
    maxRetries: 3,
    audioUrl: '/uploads/audio/x.mp3',
    inputText: 'hello',
    transcribedText: null,
    generatedAudioUrl: null,
    ...overrides,
  }) as VoiceJob;

const makeBullJob = (jobId = 'job-123') =>
  ({
    id: 'bull-1',
    data: { jobId, correlationId: `voice-${jobId}` },
    attemptsMade: 0,
    opts: { attempts: 5 },
  }) as any;

describe('VoiceProcessor', () => {
  let processor: VoiceProcessor;
  let voiceService: {
    findOne: jest.Mock;
    hasCompletedOutput: jest.Mock;
    markStarted: jest.Mock;
    advanceStage: jest.Mock;
    markCompleted: jest.Mock;
    markFailed: jest.Mock;
    recordFailureAndDecideRetry: jest.Mock;
  };
  let provider: { transcribe: jest.Mock; synthesize: jest.Mock };
  let metrics: {
    recordJobStart: jest.Mock;
    recordJobCompleted: jest.Mock;
    recordJobFailed: jest.Mock;
    recordVoiceRetry: jest.Mock;
    recordProviderFailure: jest.Mock;
  };
  let logging: {
    info: jest.Mock;
    error: jest.Mock;
    warn: jest.Mock;
    debug: jest.Mock;
  };

  beforeEach(async () => {
    voiceService = {
      findOne: jest.fn(),
      hasCompletedOutput: jest.fn(),
      markStarted: jest.fn().mockResolvedValue(undefined),
      advanceStage: jest.fn().mockResolvedValue(undefined),
      markCompleted: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
      recordFailureAndDecideRetry: jest.fn(),
    };
    provider = { transcribe: jest.fn(), synthesize: jest.fn() };
    metrics = {
      recordJobStart: jest.fn(),
      recordJobCompleted: jest.fn(),
      recordJobFailed: jest.fn(),
      recordVoiceRetry: jest.fn(),
      recordProviderFailure: jest.fn(),
    };
    logging = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoiceProcessor,
        { provide: VoiceService, useValue: voiceService },
        { provide: VoiceProviderService, useValue: provider },
        { provide: MetricsService, useValue: metrics },
        { provide: LoggingService, useValue: logging },
      ],
    }).compile();

    processor = module.get<VoiceProcessor>(VoiceProcessor);
  });

  describe('happy path (TEST 1)', () => {
    it('progresses an STT job through transcription to completion', async () => {
      voiceService.findOne.mockResolvedValue(makeJob());
      voiceService.hasCompletedOutput.mockReturnValue(false);
      provider.transcribe.mockResolvedValue('hello world');

      const result = await processor.handleSTT(makeBullJob());

      expect(result.success).toBe(true);
      expect(voiceService.markStarted).toHaveBeenCalledWith(
        'job-123',
        VoiceJobStage.TRANSCRIBING,
      );
      expect(provider.transcribe).toHaveBeenCalledWith('/uploads/audio/x.mp3');
      expect(voiceService.advanceStage).toHaveBeenCalledWith(
        'job-123',
        VoiceJobStage.TRANSCRIPTION_COMPLETED,
        { transcribedText: 'hello world' },
      );
      expect(voiceService.markCompleted).toHaveBeenCalled();
      expect(metrics.recordJobStart).toHaveBeenCalled();
      expect(metrics.recordJobCompleted).toHaveBeenCalled();
    });

    it('progresses a TTS job through generation to completion', async () => {
      voiceService.findOne.mockResolvedValue(makeJob({ type: JobType.TTS }));
      voiceService.hasCompletedOutput.mockReturnValue(false);
      provider.synthesize.mockResolvedValue('/uploads/tts/job-123-speech.mp3');

      const result = await processor.handleTTS(makeBullJob());

      expect(result.success).toBe(true);
      expect(voiceService.markStarted).toHaveBeenCalledWith(
        'job-123',
        VoiceJobStage.GENERATING_TTS,
      );
      expect(provider.synthesize).toHaveBeenCalledWith('hello', 'job-123');
      expect(voiceService.markCompleted).toHaveBeenCalledWith('job-123', {
        generatedAudioUrl: '/uploads/tts/job-123-speech.mp3',
      });
    });
  });

  describe('transcription provider failure (TEST 2)', () => {
    it('normalizes a transient transcription failure and schedules a retry', async () => {
      voiceService.findOne.mockResolvedValue(makeJob());
      voiceService.hasCompletedOutput.mockReturnValue(false);
      provider.transcribe.mockRejectedValue(
        transientProviderFailure(
          VoiceErrorCode.PROVIDER_TIMEOUT,
          'timed out',
          'whisper',
          VoiceJobStage.TRANSCRIBING,
        ),
      );
      voiceService.recordFailureAndDecideRetry.mockResolvedValue({
        retry: true,
      });

      await expect(processor.handleSTT(makeBullJob())).rejects.toThrow();

      expect(voiceService.recordFailureAndDecideRetry).toHaveBeenCalledWith(
        'job-123',
        expect.objectContaining({
          code: VoiceErrorCode.PROVIDER_TIMEOUT,
          retryable: true,
          provider: 'whisper',
          stage: VoiceJobStage.TRANSCRIBING,
        }),
      );
      expect(metrics.recordProviderFailure).toHaveBeenCalledWith(
        'whisper',
        VoiceJobStage.TRANSCRIBING,
        VoiceErrorCode.PROVIDER_TIMEOUT,
        'voice-job-123',
      );
      expect(metrics.recordVoiceRetry).toHaveBeenCalled();
    });
  });

  describe('resume from checkpoint after TTS failure (TEST 3)', () => {
    it('does not re-generate speech when the audio output is already persisted', async () => {
      voiceService.findOne.mockResolvedValue(
        makeJob({
          type: JobType.TTS,
          status: JobStatus.PROCESSING,
          stage: VoiceJobStage.GENERATING_TTS,
          generatedAudioUrl: '/uploads/tts/job-123-speech.mp3',
        }),
      );
      voiceService.hasCompletedOutput.mockReturnValue(true);

      const result = await processor.handleTTS(makeBullJob());

      expect(result).toEqual({ success: true, resumed: true });
      expect(provider.synthesize).not.toHaveBeenCalled();
      expect(voiceService.markCompleted).toHaveBeenCalled();
      expect(metrics.recordJobCompleted).toHaveBeenCalled();
    });
  });

  describe('worker interruption (TEST 4)', () => {
    it('resumes from a persisted transcript instead of re-transcribing', async () => {
      voiceService.findOne.mockResolvedValue(
        makeJob({
          type: JobType.STT,
          status: JobStatus.PROCESSING,
          stage: VoiceJobStage.TRANSCRIPTION_COMPLETED,
          transcribedText: 'already transcribed',
        }),
      );
      voiceService.hasCompletedOutput.mockReturnValue(true);

      const result = await processor.handleSTT(makeBullJob());

      expect(result).toEqual({ success: true, resumed: true });
      expect(provider.transcribe).not.toHaveBeenCalled();
      expect(voiceService.markCompleted).toHaveBeenCalled();
    });
  });

  describe('duplicate / idempotent processing (TEST 5)', () => {
    it('treats an already-completed job as a no-op', async () => {
      voiceService.findOne.mockResolvedValue(
        makeJob({ status: JobStatus.COMPLETED, transcribedText: 'done' }),
      );

      const result = await processor.handleSTT(makeBullJob());

      expect(result).toEqual({ success: true, resumed: true });
      expect(provider.transcribe).not.toHaveBeenCalled();
      expect(voiceService.markCompleted).not.toHaveBeenCalled();
      expect(voiceService.recordFailureAndDecideRetry).not.toHaveBeenCalled();
    });
  });

  describe('retry exhaustion (TEST 6)', () => {
    it('stops retrying and returns a permanent failure when the budget is exhausted', async () => {
      voiceService.findOne.mockResolvedValue(makeJob({ type: JobType.TTS }));
      voiceService.hasCompletedOutput.mockReturnValue(false);
      provider.synthesize.mockRejectedValue(
        transientProviderFailure(
          VoiceErrorCode.PROVIDER_UNAVAILABLE,
          '5xx',
          'openai-tts',
          VoiceJobStage.GENERATING_TTS,
        ),
      );
      voiceService.recordFailureAndDecideRetry.mockResolvedValue({
        retry: false,
      });

      const result = await processor.handleTTS(makeBullJob());

      expect(result).toEqual({ success: false });
      expect(metrics.recordJobFailed).toHaveBeenCalled();
      // No throw → Bull does not redeliver.
    });
  });

  describe('non-retryable provider failure (TEST 7)', () => {
    it('does not retry invalid audio and records the permanent failure', async () => {
      voiceService.findOne.mockResolvedValue(makeJob());
      voiceService.hasCompletedOutput.mockReturnValue(false);
      provider.transcribe.mockRejectedValue(
        validationFailure(VoiceErrorCode.INVALID_AUDIO, 'unsupported format'),
      );
      voiceService.recordFailureAndDecideRetry.mockResolvedValue({
        retry: false,
      });

      const result = await processor.handleSTT(makeBullJob());

      expect(result).toEqual({ success: false });
      expect(voiceService.recordFailureAndDecideRetry).toHaveBeenCalledWith(
        'job-123',
        expect.objectContaining({
          retryable: false,
          code: VoiceErrorCode.INVALID_AUDIO,
        }),
      );
      expect(metrics.recordVoiceRetry).not.toHaveBeenCalled();
    });
  });

  describe('concurrent processing (TEST 10)', () => {
    it('second worker short-circuits once the first marks the job complete', async () => {
      voiceService.findOne
        .mockResolvedValueOnce(makeJob()) // first worker sees pending
        .mockResolvedValueOnce(
          makeJob({ status: JobStatus.COMPLETED, transcribedText: 'done' }),
        ); // second sees completed
      voiceService.hasCompletedOutput.mockReturnValue(false);
      provider.transcribe.mockResolvedValue('hello world');

      const first = await processor.handleSTT(makeBullJob());
      const second = await processor.handleSTT(makeBullJob());

      expect(first.success).toBe(true);
      expect(second).toEqual({ success: true, resumed: true });
      expect(provider.transcribe).toHaveBeenCalledTimes(1);
    });
  });

  describe('OnQueueFailed safety net', () => {
    it('marks the job failed when Bull exhausts its own attempts', async () => {
      const job = makeBullJob();
      job.attemptsMade = 5;
      job.opts.attempts = 5;
      voiceService.findOne.mockResolvedValue(
        makeJob({ status: JobStatus.PROCESSING }),
      );

      await processor.onFailed(job, new Error('unexpected'));

      expect(voiceService.markFailed).toHaveBeenCalled();
    });

    it('does nothing when retries remain', async () => {
      const job = makeBullJob();
      job.attemptsMade = 1;
      job.opts.attempts = 5;

      await processor.onFailed(job, new Error('transient'));

      expect(voiceService.markFailed).not.toHaveBeenCalled();
    });
  });
});
