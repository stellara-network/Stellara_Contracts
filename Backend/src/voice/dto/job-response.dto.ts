import { JobStatus, JobType } from '../entities/voice-job.entity';

export class JobResponseDto {
  id: string;
  type: JobType;
  status: JobStatus;
  transcribedText?: string;
  generatedAudioUrl?: string;
  errorMessage?: string;
  retryCount: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}