import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { VoiceJobStage } from '../types/voice-job-stage.enum';
import type { VoiceFailureMetadata } from '../types/voice-errors';

export enum JobStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum JobType {
  STT = 'stt',
  TTS = 'tts',
}

@Entity('voice_jobs')
@Index(['status', 'createdAt'])
@Index(['userId', 'createdAt'])
export class VoiceJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: JobType })
  type: JobType;

  @Column({ type: 'enum', enum: JobStatus, default: JobStatus.PENDING })
  status: JobStatus;

  /** Fine-grained pipeline stage; the checkpoint used to resume safely. */
  @Column({
    type: 'enum',
    enum: VoiceJobStage,
    default: VoiceJobStage.QUEUED,
  })
  stage: VoiceJobStage;

  /** Persisted progress (0-100). Never exceeds 100; failed jobs stay < 100. */
  @Column({ type: 'int', default: 0 })
  progress: number;

  @Column({ nullable: true })
  userId: string;

  // Audio file information
  @Column({ nullable: true })
  audioUrl: string;

  @Column({ nullable: true })
  audioHash: string; // For deduplication

  // Processing results
  @Column({ type: 'text', nullable: true })
  transcribedText: string;

  @Column({ nullable: true })
  generatedAudioUrl: string;

  // Input for TTS
  @Column({ type: 'text', nullable: true })
  inputText: string;

  // Error handling
  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  /** Structured, safe failure metadata (code, category, retryable, …). */
  @Column({ type: 'jsonb', nullable: true })
  failure: VoiceFailureMetadata | null;

  /** Number of processing attempts already consumed (1 + retries). */
  @Column({ type: 'int', default: 0 })
  retryCount: number;

  /** Maximum number of processing attempts allowed (default 3). */
  @Column({ type: 'int', default: 3 })
  maxRetries: number;

  // Metadata
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  failedAt: Date | null;
}
