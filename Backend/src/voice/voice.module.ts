import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { VoiceGateway } from './voice.gateway';
import { VoiceSessionService } from './services/voice-session.service';
import { ConversationStateMachineService } from './services/conversation-state-machine.service';
import { StreamingResponseService } from './services/streaming-response.service';
import { SessionCleanupService } from './services/session-cleanup.service';
import { LlmService } from './services/llm.service';
import { QuotaService } from './services/quota.service';
import { LlmCacheService } from './services/llm-cache.service';
import { VoiceJob } from './entities/voice-job.entity';
import { VoiceSession } from './entities/voice-session.entity';
import { AiUsageQuota } from '../ai/quota/quota.entity';
import { JwtService } from '@nestjs/jwt';
import { WsJwtAuthGuard } from '../auth/guards/ws-jwt-auth.guard';
import { RedisModule } from '../redis/redis.module';
import { ObservabilityModule } from '../observability/observability.module';
import { QueueJobTracingWrapper } from '../observability/middleware/queue-job-tracing.wrapper';
import type { Queue } from 'bull';
import { VoiceProcessor } from './voice.processor';
import { VoiceProviderService } from './providers/voice-provider.service';

/**
 * Bull-level attempts for the voice queue. The persisted `maxRetries` budget is
 * authoritative; this value is only an upper bound so Bull never gives up
 * before the persisted decision has been made.
 */
const VOICE_QUEUE_ATTEMPTS = Number(process.env.VOICE_QUEUE_ATTEMPTS) || 5;

@Module({
  imports: [
    RedisModule,
    ObservabilityModule,
    TypeOrmModule.forFeature([VoiceSession, VoiceJob, AiUsageQuota]),
    BullModule.registerQueue({
      name: 'voice-processing',
      defaultJobOptions: {
        attempts: VOICE_QUEUE_ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  providers: [
    VoiceGateway,
    VoiceSessionService,
    ConversationStateMachineService,
    StreamingResponseService,
    SessionCleanupService,
    LlmService,
    QuotaService,
    LlmCacheService,
    JwtService,
    WsJwtAuthGuard,
    VoiceProcessor,
    VoiceProviderService,
  ],
  exports: [
    VoiceSessionService,
    ConversationStateMachineService,
    StreamingResponseService,
    LlmService,
    QuotaService,
    LlmCacheService,
  ],
})
export class VoiceModule implements OnModuleInit {
  constructor(
    private readonly queueJobTracingWrapper: QueueJobTracingWrapper,
    @InjectQueue('voice-processing')
    private readonly voiceProcessingQueue: Queue,
  ) {}

  async onModuleInit() {
    this.queueJobTracingWrapper.wrapQueueMetrics(
      this.voiceProcessingQueue,
      'voice-processing',
    );
  }
}
