import { randomUUID as uuidv4 } from 'crypto';
import { ConversationState } from '../types/conversation-state.enum';
import { FeatureContext } from '../types/feature-context.enum';
import { Entity, Column, PrimaryColumn, Index } from 'typeorm';

export interface VoiceMessage {
  id: string;
  content: string;
  timestamp: Date;
  isUser: boolean;
  metadata?: Record<string, any>;
}

@Entity('voice_sessions')
export class VoiceSession {
  @PrimaryColumn()
  id: string;

  @Column()
  @Index()
  userId: string;

  @Column({ nullable: true })
  walletAddress?: string;

  @Column({ type: 'varchar' })
  context: FeatureContext;

  @Column({ type: 'varchar' })
  state: ConversationState;

  @Column({ type: 'json' })
  messages: VoiceMessage[];

  @Column({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz' })
  lastActivityAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastPingAt?: Date;

  @Column({ type: 'int' })
  ttl: number;

  @Column({ nullable: true })
  socketId?: string;

  @Column({ type: 'json', nullable: true })
  metadata?: Record<string, any>;

  static create(
    userId: string,
    context: FeatureContext,
    walletAddress?: string,
    metadata?: Record<string, any>,
  ): VoiceSession {
    const now = new Date();
    const session = new VoiceSession();
    session.id = uuidv4();
    session.userId = userId;
    session.walletAddress = walletAddress;
    session.context = context;
    session.state = ConversationState.IDLE;
    session.messages = [];
    session.createdAt = now;
    session.lastActivityAt = now;
    session.ttl = 3600;
    session.metadata = metadata;
    return session;
  }
}
