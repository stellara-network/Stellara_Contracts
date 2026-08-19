import { Processor, Process, OnQueueFailed } from '@nestjs/bull';
import type { Job } from 'bull';
import { Inject, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { JobResult } from '../types/job.types';
import { ValidationError } from '../types/errors';
import { MetricsService } from '../../observability/services/metrics.service';
import { QueueJobTracingWrapper } from '../../observability/middleware/queue-job-tracing.wrapper';

interface ProcessTtsData {
  text: string;
  voiceId: string;
  language?: string;
  speed?: number;
  sessionId?: string;
}

@Processor('process-tts')
export class ProcessTtsProcessor {
  private readonly logger = new Logger(ProcessTtsProcessor.name);

  constructor(
    @InjectQueue('failed-jobs') private readonly dlqQueue: Queue,
    private readonly queueJobTracingWrapper: QueueJobTracingWrapper,
    @Optional()
    @Inject(MetricsService)
    private readonly metrics?: MetricsService,
  ) {}

  @Process()
  async handleProcessTts(job: Job<ProcessTtsData>): Promise<JobResult> {
    const wrappedProcess = this.queueJobTracingWrapper.wrapProcessor(
      async (jobToProcess: Job<ProcessTtsData>) => {
        const {
          text,
          voiceId,
          language = 'en',
          speed = 1.0,
          sessionId,
        } = jobToProcess.data;
        const start = Date.now();
        const correlationId =
          (jobToProcess.data as any)?.correlationId ||
          'process-tts-' + (jobToProcess as any).id;

        this.logger.log(
          `Processing TTS job ${jobToProcess.id}: voiceId=${voiceId}, length=${text.length}`,
        );

        this.metrics?.recordJobStart('process-tts', correlationId);

        try {
          await jobToProcess.progress(10);

          if (!text || !voiceId) {
            throw new ValidationError('Missing required fields: text, voiceId');
          }

          if (text.length > 5000) {
            throw new ValidationError(
              'Text exceeds maximum length of 5000 characters',
            );
          }

          this.logger.debug(`Processing TTS for voice ${voiceId}...`);
          await jobToProcess.progress(30);

          const preprocessedText = this.preprocessText(text);
          await jobToProcess.progress(50);

          const audioBuffer = await this.synthesizeAudio(
            preprocessedText,
            voiceId,
            language,
            speed,
          );

          await jobToProcess.progress(80);

          const encodedAudio = await this.encodeAudio(audioBuffer);
          await jobToProcess.progress(100);

          this.logger.log(
            `TTS processing completed: ${audioBuffer.length} bytes → ${encodedAudio.length} bytes (encoded)`,
          );

          const duration = (Date.now() - start) / 1000;
          this.metrics?.recordJobCompleted(
            'process-tts',
            duration,
            correlationId,
          );

          return {
            success: true,
            data: {
              audioUrl: `/audio/${jobToProcess.id}.mp3`,
              duration: audioBuffer.length / 48000,
              voiceId,
              language,
              speed,
              sessionId,
              processedAt: new Date().toISOString(),
            },
          };
        } catch (error) {
          const duration = (Date.now() - start) / 1000;
          this.metrics?.recordJobFailed(
            'process-tts',
            duration,
            error.constructor.name,
            correlationId,
          );
          this.logger.error(
            `Failed to process TTS: ${error.message}`,
            error.stack,
          );
          throw error;
        }
      },
      'process-tts',
    );

    return wrappedProcess(job);
  }

  @OnQueueFailed()
  async onFailed(job: Job<ProcessTtsData>, err: Error): Promise<void> {
    const attemptsExhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    const isPermanent = (err as any).retryable === false;

    if (attemptsExhausted || isPermanent) {
      this.logger.error(
        `Job ${job.id} exhausted retries or is permanent — routing to DLQ`,
        err.stack,
      );
      await this.dlqQueue.add({
        originalQueue: 'process-tts',
        originalJobId: job.id,
        failedReason: err.message,
        payload: job.data,
      });
    }
  }

  private preprocessText(text: string): string {
    return text
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s.,!?-]/g, '');
  }

  private async synthesizeAudio(
    text: string,
    voiceId: string,
    language: string,
    speed: number,
  ): Promise<Buffer> {
    return new Promise((resolve) => {
      setTimeout(() => {
        const estimatedLength = (text.split(' ').length * 100 * 48000) / 1000;
        resolve(Buffer.alloc(Math.round(estimatedLength)));
      }, 2000);
    });
  }

  private async encodeAudio(audioBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve) => {
      setTimeout(() => {
        const compressed = Buffer.alloc(Math.round(audioBuffer.length * 0.3));
        resolve(compressed);
      }, 1000);
    });
  }
}
