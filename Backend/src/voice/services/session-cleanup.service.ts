import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { VoiceSessionService } from './voice-session.service';

@Injectable()
export class SessionCleanupService implements OnModuleInit {
  private readonly logger = new Logger(SessionCleanupService.name);
  private cleanupInterval: NodeJS.Timeout;
  private readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(private readonly voiceSessionService: VoiceSessionService) {}

  async onModuleInit() {
    this.startCleanupScheduler();
    this.logger.log('Session cleanup service initialized');
  }

  private startCleanupScheduler() {
    this.cleanupInterval = setInterval(
      async () => {
        await this.performCleanup();
      },
      this.CLEANUP_INTERVAL_MS,
    );
  }

  async performCleanup() {
    try {
      this.logger.debug('Starting session cleanup...');
      const cleanedCount = await this.voiceSessionService.cleanupExpiredSessions();
      
      if (cleanedCount > 0) {
        this.logger.log(`Cleaned up ${cleanedCount} expired sessions`);
      } else {
        this.logger.debug('No expired sessions to clean up');
      }
    } catch (error) {
      this.logger.error('Error during session cleanup:', error);
    }
  }

  async onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.logger.log('Session cleanup service stopped');
    }
  }

  // Manual cleanup trigger for testing or admin use
  async triggerCleanup(): Promise<number> {
    const cleanedCount = await this.voiceSessionService.cleanupExpiredSessions();
    return cleanedCount;
  }
}
