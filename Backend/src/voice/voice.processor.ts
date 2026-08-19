// src/voice/voice.processor.ts
import { Process, Processor, OnQueueFailed } from '@nestjs/bull';
import type { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { JobStatus, JobType, VoiceJob } from './entities/voice-job.entity';
import { VoiceJobStage } from './types/voice-job-stage.enum';
import { VoiceService } from './services/voice.service';
import { VoiceProviderService } from './providers/voice-provider.service';
import { MetricsService } from '../observability/services/metrics.service';
import { LoggingService } from '../observability/services/logging.service';
import {
  VoiceErrorCode,
  VoiceFailureMetadata,
  VoiceProcessingError,
  normalizeVoiceError,
} from './types/voice-errors';

interface VoiceJobData {
  jobId: string;
  correlationId?: string;
}

type VoiceJobResult = { success: boolean; resumed?: boolean };

@Processor('voice-processing')
export class VoiceProcessor {
  private readonly logger = new Logger(VoiceProcessor.name);

  constructor(
    private voiceService: VoiceService,
    private provider: VoiceProviderService,
    private readonly metricsService: MetricsService,
    private readonly loggingService: LoggingService,
  ) {}

  @Process('process-stt')
  async handleSTT(job: Job<VoiceJobData>): Promise<VoiceJobResult> {
    return this.process(job, JobType.STT);
  }

  @Process('process-tts')
  async handleTTS(job: Job<VoiceJobData>): Promise<VoiceJobResult> {
    return this.process(job, JobType.TTS);
  }

  /**
   * Shared, resumable pipeline driver.
   *
   * The persisted `VoiceJob` row is the source of truth. Each attempt:
   *  1. short-circuits if the job is already complete (idempotent),
   *  2. short-circuits if the terminal output is already persisted
   *     (checkpoint resume — no redundant provider work),
   *  3. otherwise performs the remaining external work and persists a
   *     checkpoint before calling the next stage.
   *
   * Failures are normalized, persisted as structured metadata, and either
   * retried (bounded) or marked permanently failed.
   */
  private async process(
    job: Job<VoiceJobData>,
    type: JobType,
  ): Promise<VoiceJobResult> {
    const { jobId } = job.data;
    const correlationId = job.data.correlationId ?? `voice-${jobId}`;
    const start = Date.now();

    this.metricsService.recordJobStart('voice-processing', correlationId);

    try {
      const voiceJob = await this.voiceService.findOne(jobId);
      if (!voiceJob) {
        // Internal inconsistency: nothing to retry against.
        const failure = normalizeVoiceError(new Error('Job not found'), {
          code: VoiceErrorCode.INTERNAL_ERROR,
          stage: VoiceJobStage.QUEUED,
        });
        this.recordFailureMetrics(type, correlationId, failure);
        this.finishFailed(
          failure.toMetadata(0, correlationId),
          correlationId,
          jobId,
          start,
        );
        return { success: false };
      }

      // Idempotency: already completed → no-op.
      if (voiceJob.status === JobStatus.COMPLETED) {
        this.recordJobCompleted(correlationId, start);
        return { success: true, resumed: true };
      }

      // Checkpoint resume: terminal output already persisted → just finalize.
      if (this.voiceService.hasCompletedOutput(voiceJob)) {
        await this.voiceService.markCompleted(jobId);
        this.loggingService.info('Voice job resumed from checkpoint', {
          correlationId,
          jobId,
          type,
          stage: voiceJob.stage,
        });
        this.recordJobCompleted(correlationId, start);
        return { success: true, resumed: true };
      }

      if (type === JobType.STT) {
        await this.runStt(jobId, voiceJob, correlationId);
      } else {
        await this.runTts(jobId, voiceJob, correlationId);
      }

      this.loggingService.info('Voice job completed', {
        correlationId,
        jobId,
        type,
        stage: VoiceJobStage.COMPLETED,
      });
      this.recordJobCompleted(correlationId, start);
      return { success: true };
    } catch (error) {
      const failure = normalizeVoiceError(error, {
        code:
          type === JobType.STT
            ? VoiceErrorCode.TRANSCRIPTION_FAILED
            : VoiceErrorCode.TTS_FAILED,
        stage:
          type === JobType.STT
            ? VoiceJobStage.TRANSCRIBING
            : VoiceJobStage.GENERATING_TTS,
      });

      this.recordFailureMetrics(type, correlationId, failure);

      const { retry } = await this.voiceService.recordFailureAndDecideRetry(
        jobId,
        failure.toMetadata(0, correlationId),
      );

      if (retry) {
        this.metricsService.recordVoiceRetry(type, correlationId);
        this.recordJobFailed(correlationId, start);
        throw error; // Bull applies backoff and redelivers.
      }

      this.finishFailed(
        failure.toMetadata(0, correlationId),
        correlationId,
        jobId,
        start,
      );
      return { success: false };
    }
  }

  private async runStt(
    jobId: string,
    voiceJob: VoiceJob,
    correlationId: string,
  ): Promise<void> {
    await this.voiceService.markStarted(jobId, VoiceJobStage.TRANSCRIBING);
    this.logStage(correlationId, jobId, 'stt', VoiceJobStage.TRANSCRIBING);

    const transcribedText = await this.provider.transcribe(voiceJob.audioUrl);

    // Checkpoint: persist the transcript BEFORE finalizing, so a crash here
    // resumes from TRANSCRIPTION_COMPLETED instead of re-transcribing.
    await this.voiceService.advanceStage(
      jobId,
      VoiceJobStage.TRANSCRIPTION_COMPLETED,
      { transcribedText },
    );
    await this.voiceService.markCompleted(jobId);
  }

  private async runTts(
    jobId: string,
    voiceJob: VoiceJob,
    correlationId: string,
  ): Promise<void> {
    await this.voiceService.markStarted(jobId, VoiceJobStage.GENERATING_TTS);
    this.logStage(correlationId, jobId, 'tts', VoiceJobStage.GENERATING_TTS);

    // Deterministic artifact path keeps a retry idempotent (no duplicate files).
    const audioPath = await this.provider.synthesize(
      voiceJob.inputText ?? '',
      jobId,
    );

    await this.voiceService.markCompleted(jobId, {
      generatedAudioUrl: audioPath,
    });
  }

  private finishFailed(
    failureMetadata: VoiceFailureMetadata,
    correlationId: string,
    jobId: string,
    start: number,
  ): VoiceJobResult {
    this.loggingService.error(
      'Voice job permanently failed',
      { message: failureMetadata.message },
      {
        correlationId,
        jobId,
        code: failureMetadata.code,
        stage: failureMetadata.stage,
        retryable: failureMetadata.retryable,
      },
    );
    this.recordJobFailed(correlationId, start);
    return { success: false };
  }

  private logStage(
    correlationId: string,
    jobId: string,
    provider: 'stt' | 'tts',
    stage: VoiceJobStage,
  ): void {
    this.loggingService.info('Voice stage started', {
      correlationId,
      jobId,
      provider,
      stage,
    });
  }

  private recordFailureMetrics(
    type: JobType,
    correlationId: string,
    failure: VoiceProcessingError,
  ): void {
    this.metricsService.recordProviderFailure(
      failure.provider ?? (type === JobType.STT ? 'whisper' : 'openai-tts'),
      String(failure.stage ?? ''),
      failure.code,
      correlationId,
    );
    this.loggingService.error(
      'Voice provider failure',
      { message: failure.message },
      {
        correlationId,
        type,
        provider: failure.provider,
        stage: failure.stage,
        code: failure.code,
        category: failure.category,
        retryable: failure.retryable,
      },
    );
  }

  private recordJobCompleted(correlationId: string, start: number): void {
    const duration = (Date.now() - start) / 1000;
    this.metricsService.recordJobCompleted(
      'voice-processing',
      duration,
      correlationId,
    );
  }

  private recordJobFailed(correlationId: string, start: number): void {
    const duration = (Date.now() - start) / 1000;
    this.metricsService.recordJobFailed(
      'voice-processing',
      duration,
      'VoiceProcessingError',
      correlationId,
    );
  }

  /**
   * Safety net for unexpected failures that bypass the normal retry decision
   * (e.g. a database outage). If Bull has exhausted its own attempts, ensure
   * the persisted job is marked failed rather than left mid-flight.
   */
  @OnQueueFailed()
  async onFailed(job: Job<VoiceJobData>, err: Error): Promise<void> {
    const jobId = job?.data?.jobId;
    if (!jobId) return;

    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted) return;

    const voiceJob = await this.voiceService.findOne(jobId);
    if (
      !voiceJob ||
      voiceJob.status === JobStatus.FAILED ||
      voiceJob.status === JobStatus.COMPLETED
    ) {
      return;
    }

    const failure = normalizeVoiceError(err, {
      code: VoiceErrorCode.INTERNAL_ERROR,
      stage: voiceJob.stage,
    });
    await this.voiceService.markFailed(
      jobId,
      failure.toMetadata(job.attemptsMade),
    );
    this.logger.error(
      `Voice job ${jobId} marked failed after unexpected queue exhaustion: ${err.message}`,
    );
  }
}
