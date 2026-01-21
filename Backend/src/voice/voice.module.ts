import { Module } from '@nestjs/common';
import { VoiceGateway } from './voice.gateway';
import { VoiceSessionService } from './services/voice-session.service';
import { ConversationStateMachineService } from './services/conversation-state-machine.service';
import { StreamingResponseService } from './services/streaming-response.service';
import { SessionCleanupService } from './services/session-cleanup.service';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [
    VoiceGateway,
    VoiceSessionService,
    ConversationStateMachineService,
    StreamingResponseService,
    SessionCleanupService,
  ],
  exports: [
    VoiceSessionService,
    ConversationStateMachineService,
    StreamingResponseService,
  ],
})
export class VoiceModule {}
