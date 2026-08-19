// src/voice/voice.service.ts
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { JobStatus, JobType, VoiceJob } from '../entities/voice-job.entity';
import { VoiceJobStage } from '../types/voice-job-stage.enum';
import { clampProgress, progressForStage } from '../types/voice-pipeline';
import type { VoiceFailureMetadata } from '../types/voice-errors';

/** Stable Bull job id derived from the persisted job id (idempotent enqueue). */
const bullJobId = (jobId: string): string => `voice:${jobId}`;

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  constructor(
    @InjectRepository(VoiceJob)
    private voiceJobRepository: Repository<VoiceJob>,
    @InjectQueue('voice-processing')
    private voiceQueue: Queue,
  ) {}

  private generateHash(content: Buffer | string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  async processSTT(file: {
    buffer: Buffer;
    originalname: string;
  }): Promise<string> {
    const audioHash = this.generateHash(file.buffer);

    // Deduplicate against any in-flight or already-succeeded job, not only
    // completed ones, so a duplicate upload never spawns a second pipeline.
    const existingJob = await this.voiceJobRepository.findOne({
      where: { audioHash, type: JobType.STT },
      order: { createdAt: 'DESC' },
    });

    if (existingJob && existingJob.status !== JobStatus.FAILED) {
      return existingJob.id;
    }

    // Save file
    const uploadDir = path.join(process.cwd(), 'uploads', 'audio');
    await fs.mkdir(uploadDir, { recursive: true });
    const fileName = `${Date.now()}-${file.originalname}`;
    const filePath = path.join(uploadDir, fileName);
    await fs.writeFile(filePath, file.buffer);

    // Create job (checkpoint: UPLOADED — audio is durably persisted)
    const job = this.voiceJobRepository.create({
      type: JobType.STT,
      audioUrl: filePath,
      audioHash,
      status: JobStatus.PENDING,
      stage: VoiceJobStage.UPLOADED,
      progress: progressForStage(VoiceJobStage.UPLOADED),
    });

    await this.voiceJobRepository.save(job);
    await this.enqueue(job.id, 'process-stt');

    return job.id;
  }

  async processTTS(text: string): Promise<string> {
    const audioHash = this.generateHash(text);

    const existingJob = await this.voiceJobRepository.findOne({
      where: { audioHash, type: JobType.TTS },
      order: { createdAt: 'DESC' },
    });

    if (existingJob && existingJob.status !== JobStatus.FAILED) {
      return existingJob.id;
    }

    const job = this.voiceJobRepository.create({
      type: JobType.TTS,
      inputText: text,
      audioHash,
      status: JobStatus.PENDING,
      stage: VoiceJobStage.QUEUED,
      progress: progressForStage(VoiceJobStage.QUEUED),
    });

    await this.voiceJobRepository.save(job);
    await this.enqueue(job.id, 'process-tts');

    return job.id;
  }

  /**
   * Enqueue (or re-enqueue) a job. The deterministic Bull job id makes this
   * idempotent: a repeated enqueue of the same job does not create a second
   * Bull job.
   */
  private async enqueue(
    jobId: string,
    jobName: 'process-stt' | 'process-tts',
  ): Promise<void> {
    await this.voiceQueue.add(
      jobName,
      { jobId, correlationId: `voice-${jobId}` },
      { jobId: bullJobId(jobId), attempts: this.queueAttempts() },
    );
  }

  private queueAttempts(): number {
    const configured = Number(process.env.VOICE_QUEUE_ATTEMPTS);
    return Number.isFinite(configured) && configured > 0 ? configured : 5;
  }

  async getJobStatus(id: string) {
    const job = await this.mustGet(id);

    return {
      id: job.id,
      type: job.type,
      status: job.status,
      stage: job.stage,
      progress: clampProgress(job.progress),
      attempt: job.retryCount + 1,
      retryCount: job.retryCount,
      maxRetries: job.maxRetries,
      retryable: job.failure?.retryable === true,
      failure: job.failure ? this.sanitizeFailure(job.failure) : null,
      text: job.inputText || job.transcribedText,
      audioUrl: job.audioUrl,
      resultAudioUrl: job.generatedAudioUrl,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      failedAt: job.failedAt,
    };
  }

  async getJobResult(id: string) {
    const job = await this.mustGet(id);

    if (job.status !== JobStatus.COMPLETED) {
      return {
        status: job.status,
        stage: job.stage,
        progress: clampProgress(job.progress),
        message: 'Job not completed yet',
        failure: job.failure ? this.sanitizeFailure(job.failure) : null,
      };
    }

    return {
      status: job.status,
      type: job.type,
      text: job.inputText || job.transcribedText,
      resultAudioUrl: job.generatedAudioUrl,
      completedAt: job.completedAt,
    };
  }

  /**
   * Manually retry a permanently failed job. Resets the attempt budget for the
   * new cycle but never resets already-persisted outputs, so the retry resumes
   * from the last valid checkpoint instead of redoing completed work.
   */
  async retryJob(id: string): Promise<{ jobId: string }> {
    const job = await this.mustGet(id);

    if (job.status !== JobStatus.FAILED) {
      throw new BadRequestException(
        `Only failed jobs can be retried (current status: ${job.status})`,
      );
    }

    const jobName = job.type === JobType.STT ? 'process-stt' : 'process-tts';

    await this.voiceJobRepository
      .createQueryBuilder()
      .update(VoiceJob)
      .set({
        status: JobStatus.PENDING,
        stage: VoiceJobStage.QUEUED,
        progress: progressForStage(VoiceJobStage.QUEUED),
        retryCount: 0,
        failure: null,
        failedAt: null,
      })
      .where('id = :id', { id })
      .execute();

    await this.enqueue(id, jobName);
    this.logger.log(
      `Voice job ${id} manually retried (type=${job.type}); resuming from checkpoint`,
    );

    return { jobId: id };
  }

  // ── State transitions (called by the processor) ─────────────────────────

  /** Persist a stage transition + progress (with throttling by stage granularity). */
  async advanceStage(
    id: string,
    stage: VoiceJobStage,
    extra: Partial<VoiceJob> = {},
  ): Promise<void> {
    const updates: Partial<VoiceJob> = {
      status: JobStatus.PROCESSING,
      stage,
      progress: progressForStage(stage),
      ...extra,
    };

    await this.voiceJobRepository.update(id, updates);
  }

  /**
   * Mark the job as processing. `startedAt` is only set once, on the first
   * attempt, so retries preserve the original start time.
   */
  async markStarted(id: string, stage: VoiceJobStage): Promise<void> {
    await this.voiceJobRepository.update(id, {
      status: JobStatus.PROCESSING,
      stage,
      progress: progressForStage(stage),
    });

    await this.voiceJobRepository
      .createQueryBuilder()
      .update(VoiceJob)
      .set({ startedAt: new Date() })
      .where('id = :id AND "startedAt" IS NULL', { id })
      .execute();
  }

  async markCompleted(
    id: string,
    extra: Partial<VoiceJob> = {},
  ): Promise<void> {
    await this.voiceJobRepository
      .createQueryBuilder()
      .update(VoiceJob)
      .set({
        status: JobStatus.COMPLETED,
        stage: VoiceJobStage.COMPLETED,
        progress: 100,
        completedAt: new Date(),
        failure: null,
        ...extra,
      })
      .where('id = :id AND status != :completed', {
        id,
        completed: JobStatus.COMPLETED,
      })
      .execute();
  }

  async markFailed(id: string, failure: VoiceFailureMetadata): Promise<void> {
    const safeFailure = this.sanitizeFailure({
      ...failure,
      // A terminal failure is never retryable from the API's perspective.
      retryable: false,
    });

    await this.voiceJobRepository
      .createQueryBuilder()
      .update(VoiceJob)
      .set({
        status: JobStatus.FAILED,
        stage: VoiceJobStage.FAILED,
        failedAt: new Date(),
        errorMessage: safeFailure.message,
        failure: safeFailure,
      })
      .where('id = :id', { id })
      .execute();
  }

  /**
   * Record a failure and decide whether the job should be retried.
   * Increments `retryCount` atomically and persists structured failure
   * metadata. Returns true when the caller should trigger a retry.
   */
  async recordFailureAndDecideRetry(
    id: string,
    failure: VoiceFailureMetadata,
  ): Promise<{ retry: boolean }> {
    const job = await this.mustGet(id);
    const attempt = job.retryCount + 1;

    await this.voiceJobRepository.increment({ id }, 'retryCount', 1);

    if (!failure.retryable) {
      await this.markFailed(id, { ...failure, attempt });
      return { retry: false };
    }

    if (attempt >= job.maxRetries) {
      await this.markFailed(id, { ...failure, attempt });
      return { retry: false };
    }

    // Retryable and within budget: park the job in PENDING and keep the
    // checkpoint stage + progress so the next attempt resumes safely.
    await this.voiceJobRepository.update(id, {
      status: JobStatus.PENDING,
      errorMessage: this.sanitizeFailure(failure).message,
      failure: this.sanitizeFailure({ ...failure, attempt, retryable: true }),
    });

    this.logger.warn(
      `Voice job ${id} retrying (attempt ${attempt}/${job.maxRetries}, ` +
        `code=${failure.code}, stage=${failure.stage})`,
    );

    return { retry: true };
  }

  // ── Checkpoints ─────────────────────────────────────────────────────────

  /** True if the job's terminal output is already persisted. */
  hasCompletedOutput(job: VoiceJob): boolean {
    if (job.type === JobType.STT) {
      return (
        typeof job.transcribedText === 'string' &&
        job.transcribedText.length > 0
      );
    }
    if (job.type === JobType.TTS) {
      return (
        typeof job.generatedAudioUrl === 'string' &&
        job.generatedAudioUrl.length > 0
      );
    }
    return false;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  async findOne(id: string): Promise<VoiceJob | null> {
    return this.voiceJobRepository.findOne({ where: { id } });
  }

  private async mustGet(id: string): Promise<VoiceJob> {
    const job = await this.voiceJobRepository.findOne({ where: { id } });
    if (!job) {
      throw new NotFoundException('Job not found');
    }
    return job;
  }

  /** Defensively strip any unexpected sensitive/verbose fields before exposure. */
  private sanitizeFailure(failure: VoiceFailureMetadata): VoiceFailureMetadata {
    return {
      code: failure.code,
      category: failure.category,
      message: failure.message,
      retryable: failure.retryable,
      stage: failure.stage,
      attempt: failure.attempt,
      timestamp: failure.timestamp,
      ...(failure.provider !== undefined ? { provider: failure.provider } : {}),
      ...(failure.correlationId !== undefined
        ? { correlationId: failure.correlationId }
        : {}),
    };
  }
}
