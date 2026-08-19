import { JobStatus, JobType } from '../entities/voice-job.entity';
import { VoiceJobStage } from '../types/voice-job-stage.enum';
import type { VoiceFailureMetadata } from '../types/voice-errors';

export class JobResponseDto {
  id: string;
  type: JobType;
  status: JobStatus;
  stage: VoiceJobStage;
  progress: number;
  attempt: number;
  retryCount: number;
  maxRetries: number;
  retryable: boolean;
  failure?: VoiceFailureMetadata | null;
  text?: string;
  transcribedText?: string;
  generatedAudioUrl?: string;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
}
