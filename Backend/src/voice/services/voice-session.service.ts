import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { ConversationStateMachineService } from './conversation-state-machine.service';
import { VoiceSession, VoiceMessage, VoiceSessionFactory } from '../entities/voice-session.entity';
import { ConversationState } from '../types/conversation-state.enum';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class VoiceSessionService implements OnModuleInit {
  private readonly logger = new Logger(VoiceSessionService.name);
  private readonly SESSION_PREFIX = 'voice:session:';
  private readonly USER_SESSIONS_PREFIX = 'voice:user:sessions:';
  private readonly SESSION_TTL = 3600; // 1 hour

  constructor(
    private readonly redisService: RedisService,
    private readonly stateMachine: ConversationStateMachineService,
  ) {}

  async onModuleInit() {
    this.logger.log('VoiceSessionService initialized');
  }

  async createSession(
    userId: string,
    context: any,
    walletAddress?: string,
    metadata?: Record<string, any>,
  ): Promise<VoiceSession> {
    const session = VoiceSessionFactory.create(userId, context, walletAddress, metadata);
    
    await this.saveSession(session);
    await this.addUserSession(userId, session.id);
    
    this.logger.log(`Created voice session ${session.id} for user ${userId}`);
    return session;
  }

  async getSession(sessionId: string): Promise<VoiceSession | null> {
    try {
      const sessionData = await this.redisService.client.get(this.SESSION_PREFIX + sessionId);
      if (!sessionData) {
        return null;
      }

      const session = JSON.parse(sessionData);
      return {
        ...session,
        createdAt: new Date(session.createdAt),
        lastActivityAt: new Date(session.lastActivityAt),
        messages: session.messages.map((msg: any) => ({
          ...msg,
          timestamp: new Date(msg.timestamp),
        })),
      };
    } catch (error) {
      this.logger.error(`Error retrieving session ${sessionId}:`, error);
      return null;
    }
  }

  async updateSessionState(sessionId: string, newState: ConversationState): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return false;
    }

    const transition = this.stateMachine.transition(session.state, newState);
    if (!transition.success) {
      this.logger.error(`State transition failed: ${transition.error}`);
      return false;
    }

    session.state = newState;
    session.lastActivityAt = new Date();
    
    await this.saveSession(session);
    return true;
  }

  async addMessage(
    sessionId: string,
    content: string,
    isUser: boolean,
    metadata?: Record<string, any>,
  ): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return false;
    }

    const message: VoiceMessage = {
      id: uuidv4(),
      content,
      timestamp: new Date(),
      isUser,
      metadata,
    };

    session.messages.push(message);
    session.lastActivityAt = new Date();
    
    await this.saveSession(session);
    return true;
  }

  async interruptSession(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session || !this.stateMachine.isInterruptible(session.state)) {
      return false;
    }

    return await this.updateSessionState(sessionId, ConversationState.INTERRUPTED);
  }

  async resumeSession(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return false;
    }

    const targetState = session.state === ConversationState.INTERRUPTED 
      ? ConversationState.LISTENING 
      : ConversationState.IDLE;

    return await this.updateSessionState(sessionId, targetState);
  }

  async terminateSession(sessionId: string): Promise<boolean> {
    try {
      const session = await this.getSession(sessionId);
      if (!session) {
        return false;
      }

      await this.redisService.client.del(this.SESSION_PREFIX + sessionId);
      await this.removeUserSession(session.userId, sessionId);
      
      this.logger.log(`Terminated voice session ${sessionId}`);
      return true;
    } catch (error) {
      this.logger.error(`Error terminating session ${sessionId}:`, error);
      return false;
    }
  }

  async getUserActiveSessions(userId: string): Promise<VoiceSession[]> {
    try {
      const sessionIds = await this.redisService.client.sMembers(this.USER_SESSIONS_PREFIX + userId);
      const sessions = await Promise.all(
        sessionIds.map(id => this.getSession(id))
      );
      
      return sessions.filter((session): session is VoiceSession => session !== null);
    } catch (error) {
      this.logger.error(`Error retrieving user sessions for ${userId}:`, error);
      return [];
    }
  }

  async cleanupExpiredSessions(): Promise<number> {
    const now = Date.now();
    let cleanedCount = 0;

    try {
      const keys = await this.redisService.client.keys(this.SESSION_PREFIX + '*');
      
      for (const key of keys) {
        const sessionData = await this.redisService.client.get(key);
        if (!sessionData) continue;

        const session = JSON.parse(sessionData);
        const lastActivity = new Date(session.lastActivityAt).getTime();
        const ttl = session.ttl * 1000; // Convert to milliseconds

        if (now - lastActivity > ttl) {
          const sessionId = key.replace(this.SESSION_PREFIX, '');
          await this.terminateSession(sessionId);
          cleanedCount++;
        }
      }
    } catch (error) {
      this.logger.error('Error during session cleanup:', error);
    }

    if (cleanedCount > 0) {
      this.logger.log(`Cleaned up ${cleanedCount} expired sessions`);
    }

    return cleanedCount;
  }

  async updateSessionSocket(sessionId: string, socketId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return false;
    }

    session.socketId = socketId;
    session.lastActivityAt = new Date();
    
    await this.saveSession(session);
    return true;
  }

  private async saveSession(session: VoiceSession): Promise<void> {
    const sessionData = JSON.stringify(session);
    await this.redisService.client.setEx(
      this.SESSION_PREFIX + session.id,
      session.ttl,
      sessionData,
    );
  }

  private async addUserSession(userId: string, sessionId: string): Promise<void> {
    await this.redisService.client.sAdd(this.USER_SESSIONS_PREFIX + userId, sessionId);
    await this.redisService.client.expire(this.USER_SESSIONS_PREFIX + userId, this.SESSION_TTL);
  }

  private async removeUserSession(userId: string, sessionId: string): Promise<void> {
    await this.redisService.client.sRem(this.USER_SESSIONS_PREFIX + userId, sessionId);
  }
}
