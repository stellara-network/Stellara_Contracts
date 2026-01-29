import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

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

  @Column({ type: 'int', default: 0 })
  retryCount: number;

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
  completedAt: Date;
}
