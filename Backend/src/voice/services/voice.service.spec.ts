import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { VoiceService } from './voice.service';
import { VoiceJob, JobStatus, JobType } from '../entities/voice-job.entity';
import { VoiceJobStage } from '../types/voice-job-stage.enum';
import { VoiceErrorCode, VoiceFailureMetadata } from '../types/voice-errors';

jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

const createMockRepository = () => {
  const qb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  return {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    increment: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(() => qb),
    qb,
  };
};

const makeJob = (overrides: Partial<VoiceJob> = {}): VoiceJob =>
  ({
    id: 'job-123',
    type: JobType.TTS,
    status: JobStatus.PENDING,
    stage: VoiceJobStage.QUEUED,
    progress: 30,
    retryCount: 0,
    maxRetries: 3,
    failure: null,
    inputText: 'hello',
    transcribedText: null,
    generatedAudioUrl: null,
    audioUrl: null,
    audioHash: 'hash',
    ...overrides,
  }) as VoiceJob;

describe('VoiceService', () => {
  let service: VoiceService;
  let repo: ReturnType<typeof createMockRepository>;
  let mockQueue: { add: jest.Mock };

  beforeEach(async () => {
    repo = createMockRepository();
    mockQueue = { add: jest.fn().mockResolvedValue({ id: 'bull-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoiceService,
        { provide: getRepositoryToken(VoiceJob), useValue: repo },
        { provide: getQueueToken('voice-processing'), useValue: mockQueue },
      ],
    }).compile();

    service = module.get<VoiceService>(VoiceService);
  });

  describe('processSTT', () => {
    it('creates a job at the UPLOADED checkpoint and enqueues with a stable id', async () => {
      repo.findOne.mockResolvedValue(null);
      const job = makeJob({
        id: 'job-123',
        type: JobType.STT,
        stage: VoiceJobStage.UPLOADED,
        progress: 20,
      });
      repo.create.mockReturnValue(job);
      repo.save.mockResolvedValue(job);

      const jobId = await service.processSTT({
        originalname: 'test.mp3',
        buffer: Buffer.from('test'),
      });

      expect(jobId).toBe('job-123');
      expect(repo.save).toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalledWith(
        'process-stt',
        { jobId: 'job-123', correlationId: 'voice-job-123' },
        expect.objectContaining({ jobId: 'voice:job-123' }),
      );
    });

    it('returns the existing in-flight job for a duplicate upload', async () => {
      repo.findOne.mockResolvedValue(
        makeJob({ type: JobType.STT, status: JobStatus.PROCESSING }),
      );

      const jobId = await service.processSTT({
        originalname: 'test.mp3',
        buffer: Buffer.from('test'),
      });

      expect(jobId).toBe('job-123');
      expect(repo.create).not.toHaveBeenCalled();
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it('creates a fresh job when the only match previously failed', async () => {
      repo.findOne.mockResolvedValue(
        makeJob({ type: JobType.STT, status: JobStatus.FAILED }),
      );
      repo.create.mockReturnValue(makeJob({ type: JobType.STT }));
      repo.save.mockResolvedValue(makeJob({ type: JobType.STT }));

      await service.processSTT({
        originalname: 'test.mp3',
        buffer: Buffer.from('test'),
      });

      expect(repo.create).toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalled();
    });
  });

  describe('processTTS', () => {
    it('creates a queued TTS job and enqueues it', async () => {
      repo.findOne.mockResolvedValue(null);
      repo.create.mockReturnValue(makeJob());
      repo.save.mockResolvedValue(makeJob());

      const jobId = await service.processTTS('hello');

      expect(jobId).toBe('job-123');
      expect(mockQueue.add).toHaveBeenCalledWith(
        'process-tts',
        { jobId: 'job-123', correlationId: 'voice-job-123' },
        expect.objectContaining({ jobId: 'voice:job-123' }),
      );
    });
  });

  describe('getJobStatus', () => {
    it('exposes stage, progress, attempt, retryable, and safe failure metadata', async () => {
      const failure: VoiceFailureMetadata = {
        code: VoiceErrorCode.TRANSCRIPTION_FAILED,
        category: 'provider_transient',
        message: 'timeout',
        retryable: true,
        stage: VoiceJobStage.TRANSCRIBING,
        provider: 'whisper',
        attempt: 2,
        timestamp: '2026-01-01T00:00:00.000Z',
        correlationId: 'voice-job-123',
      };
      repo.findOne.mockResolvedValue(
        makeJob({
          type: JobType.STT,
          status: JobStatus.PENDING,
          stage: VoiceJobStage.TRANSCRIBING,
          progress: 55,
          retryCount: 1,
          failure,
          transcribedText: 'partial',
        }),
      );

      const status = await service.getJobStatus('job-123');

      expect(status.id).toBe('job-123');
      expect(status.stage).toBe(VoiceJobStage.TRANSCRIBING);
      expect(status.progress).toBe(55);
      expect(status.attempt).toBe(2);
      expect(status.retryable).toBe(true);
      expect(status.failure?.code).toBe(VoiceErrorCode.TRANSCRIPTION_FAILED);
    });

    it('omits failure when there is none', async () => {
      repo.findOne.mockResolvedValue(
        makeJob({ status: JobStatus.COMPLETED, failure: null }),
      );

      const status = await service.getJobStatus('job-123');
      expect(status.failure).toBeNull();
      expect(status.retryable).toBe(false);
    });

    it('throws NotFoundException for an unknown job', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.getJobStatus('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getJobResult', () => {
    it('returns the result when completed', async () => {
      repo.findOne.mockResolvedValue(
        makeJob({
          status: JobStatus.COMPLETED,
          generatedAudioUrl: '/audio/x.mp3',
        }),
      );

      const result = await service.getJobResult('job-123');
      expect(result.status).toBe(JobStatus.COMPLETED);
      expect(result.resultAudioUrl).toBe('/audio/x.mp3');
    });

    it('reports in-progress progress and failure when not completed', async () => {
      repo.findOne.mockResolvedValue(
        makeJob({
          status: JobStatus.FAILED,
          failure: { code: 'X', retryable: false } as any,
        }),
      );

      const result = await service.getJobResult('job-123');
      expect(result.status).toBe(JobStatus.FAILED);
      expect(result.failure).toBeDefined();
    });
  });

  describe('retryJob', () => {
    it('resets a failed job and re-enqueues it', async () => {
      repo.findOne.mockResolvedValue(
        makeJob({
          status: JobStatus.FAILED,
          retryCount: 3,
          failure: { code: 'X' } as any,
        }),
      );

      const result = await service.retryJob('job-123');

      expect(result.jobId).toBe('job-123');
      expect(repo.qb.execute).toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalled();
    });

    it('rejects retry of a non-failed job', async () => {
      repo.findOne.mockResolvedValue(makeJob({ status: JobStatus.PROCESSING }));

      await expect(service.retryJob('job-123')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('recordFailureAndDecideRetry', () => {
    const failure = (retryable: boolean): VoiceFailureMetadata => ({
      code: VoiceErrorCode.TTS_FAILED,
      category: retryable ? 'provider_transient' : 'provider_permanent',
      message: 'boom',
      retryable,
      stage: VoiceJobStage.GENERATING_TTS,
      provider: 'openai-tts',
      attempt: 1,
      timestamp: new Date().toISOString(),
    });

    it('does not retry a non-retryable failure', async () => {
      repo.findOne.mockResolvedValue(makeJob({ retryCount: 0, maxRetries: 3 }));

      const result = await service.recordFailureAndDecideRetry(
        'job-123',
        failure(false),
      );

      expect(result.retry).toBe(false);
      expect(repo.qb.execute).toHaveBeenCalled();
    });

    it('retries within budget and parks the job as pending', async () => {
      repo.findOne.mockResolvedValue(makeJob({ retryCount: 0, maxRetries: 3 }));

      const result = await service.recordFailureAndDecideRetry(
        'job-123',
        failure(true),
      );

      expect(result.retry).toBe(true);
      expect(repo.increment).toHaveBeenCalledWith(
        { id: 'job-123' },
        'retryCount',
        1,
      );
      expect(repo.update).toHaveBeenCalledWith(
        'job-123',
        expect.objectContaining({ status: JobStatus.PENDING }),
      );
    });

    it('stops retrying once the budget is exhausted', async () => {
      repo.findOne.mockResolvedValue(makeJob({ retryCount: 2, maxRetries: 3 }));

      const result = await service.recordFailureAndDecideRetry(
        'job-123',
        failure(true),
      );

      expect(result.retry).toBe(false);
      expect(repo.qb.execute).toHaveBeenCalled();
    });
  });

  describe('hasCompletedOutput', () => {
    it('detects a persisted transcript for STT', () => {
      expect(
        service.hasCompletedOutput(
          makeJob({ type: JobType.STT, transcribedText: 'hello world' }),
        ),
      ).toBe(true);
    });

    it('detects a persisted audio for TTS', () => {
      expect(
        service.hasCompletedOutput(
          makeJob({ type: JobType.TTS, generatedAudioUrl: '/audio/x.mp3' }),
        ),
      ).toBe(true);
    });

    it('returns false when output is absent', () => {
      expect(service.hasCompletedOutput(makeJob({ type: JobType.TTS }))).toBe(
        false,
      );
    });
  });
});
