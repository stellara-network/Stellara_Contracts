// src/voice/voice.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { JobStatus, JobType, VoiceJob } from '../entities/voice-job.entity';

@Injectable()
export class VoiceService {
  constructor(
    @InjectRepository(VoiceJob)
    private voiceJobRepository: Repository<VoiceJob>,
    @InjectQueue('voice-processing')
    private voiceQueue: Queue,
  ) {}

  private generateHash(content: Buffer | string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  async processSTT(file: Express.Multer.File): Promise<string> {
    const contentHash = this.generateHash(file.buffer);

    // Check for duplicate
    const existingJob = await this.voiceJobRepository.findOne({
      where: { contentHash, type: JobType.STT, status: JobStatus.COMPLETED },
    });

    if (existingJob) {
      return existingJob.id;
    }

    // Save file
    const uploadDir = path.join(process.cwd(), 'uploads', 'audio');
    await fs.mkdir(uploadDir, { recursive: true });
    const fileName = `${Date.now()}-${file.originalname}`;
    const filePath = path.join(uploadDir, fileName);
    await fs.writeFile(filePath, file.buffer);

    // Create job
    const job = this.voiceJobRepository.create({
      type: JobType.STT,
      audioUrl: filePath,
      contentHash,
      status: JobStatus.PENDING,
    });

    await this.voiceJobRepository.save(job);

    // Queue processing
    await this.voiceQueue.add('process-stt', { jobId: job.id });

    return job.id;
  }

  async processTTS(text: string): Promise<string> {
    const contentHash = this.generateHash(text);

    // Check for duplicate
    const existingJob = await this.voiceJobRepository.findOne({
      where: { contentHash, type: JobType.TTS, status: JobStatus.COMPLETED },
    });

    if (existingJob) {
      return existingJob.id;
    }

    // Create job
    const job = this.voiceJobRepository.create({
      type: JobType.TTS,
      text,
      contentHash,
      status: JobStatus.PENDING,
    });

    await this.voiceJobRepository.save(job);

    // Queue processing
    await this.voiceQueue.add('process-tts', { jobId: job.id });

    return job.id;
  }

  async getJobStatus(id: string) {
    const job = await this.voiceJobRepository.findOne({ where: { id } });
    if (!job) {
      throw new NotFoundException('Job not found');
    }

    return {
      id: job.id,
      type: job.type,
      status: job.status,
      text: job.text,
      audioUrl: job.audioUrl,
      resultAudioUrl: job.resultAudioUrl,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  async getJobResult(id: string) {
    const job = await this.voiceJobRepository.findOne({ where: { id } });
    if (!job) {
      throw new NotFoundException('Job not found');
    }

    if (job.status !== JobStatus.COMPLETED) {
      return {
        status: job.status,
        message: 'Job not completed yet',
      };
    }

    return {
      status: job.status,
      type: job.type,
      text: job.text,
      resultAudioUrl: job.resultAudioUrl,
    };
  }

  async updateJobStatus(
    id: string,
    status: JobStatus,
    updates: Partial<VoiceJob> = {},
  ): Promise<void> {
    await this.voiceJobRepository.update(id, {
      status,
      ...updates,
    });
  }

  async incrementRetry(id: string): Promise<boolean> {
    const job = await this.voiceJobRepository.findOne({ where: { id } });
    if (!job) return false;

    const newRetryCount = job.retryCount + 1;
    await this.voiceJobRepository.update(id, {
      retryCount: newRetryCount,
    });

    return newRetryCount < job.maxRetries;
  }
}
