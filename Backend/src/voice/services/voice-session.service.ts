import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { ConversationStateMachineService } from './conversation-state-machine.service';
import { VoiceSession, VoiceMessage } from '../entities/voice-session.entity';
import { ConversationState } from '../types/conversation-state.enum';
import { randomUUID as uuidv4 } from 'crypto';

/** Maximum number of concurrent sessions allowed per user (AC-4) */
export const MAX_SESSIONS_PER_USER = 3;

/** Heartbeat timeout in milliseconds — sessions silent longer than this are stale (AC-2) */
export const HEARTBEAT_TIMEOUT_MS = 60_000;

@Injectable()
export class VoiceSessionService implements OnModuleInit {
  private readonly logger = new Logger(VoiceSessionService.name);

  // Redis key prefixes
  private readonly SESSION_PREFIX = 'voice:session:';
  private readonly USER_SESSIONS_PREFIX = 'voice:user:sessions:';
  private readonly USER_ACTIVE_SESSION_PREFIX = 'voice:usersession:';

  private readonly SESSION_TTL = 3600; // 1 hour — full session lifetime
  private readonly USER_SESSION_POINTER_TTL = 600; // 10 minutes (AC-1)

  constructor(
    private readonly redisService: RedisService,
    private readonly stateMachine: ConversationStateMachineService,
  ) {}

  async onModuleInit() {
    this.logger.log('VoiceSessionService initialized');
  }

  // ---------------------------------------------------------------------------
  // Session CRUD
  // ---------------------------------------------------------------------------

  async createSession(
    userId: string,
    context: any,
    walletAddress?: string,
    metadata?: Record<string, any>,
  ): Promise<VoiceSession> {
    // AC-4: enforce max 3 concurrent sessions per user
    const activeSessions = await this.getUserActiveSessions(userId);
    if (activeSessions.length >= MAX_SESSIONS_PER_USER) {
      throw new Error(
        `Session limit reached: users may have at most ${MAX_SESSIONS_PER_USER} concurrent sessions`,
      );
    }

    const session = VoiceSession.create(
      userId,
      context,
      walletAddress,
      metadata,
    );

    await this.saveSession(session);
    await this.addUserSession(userId, session.id);

    this.logger.log(`Created voice session ${session.id} for user ${userId}`);
    return session;
  }

  async getSession(sessionId: string): Promise<VoiceSession | null> {
    try {
      const sessionData = await this.redisService.client.get(
        this.SESSION_PREFIX + sessionId,
      );
      if (!sessionData) {
        return null;
      }

      const session = JSON.parse(sessionData);
      return {
        ...session,
        createdAt: new Date(session.createdAt),
        lastActivityAt: new Date(session.lastActivityAt),
        lastPingAt: session.lastPingAt
          ? new Date(session.lastPingAt)
          : undefined,
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

  async updateSessionState(
    sessionId: string,
    newState: ConversationState,
  ): Promise<boolean> {
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

    return await this.updateSessionState(
      sessionId,
      ConversationState.INTERRUPTED,
    );
  }

  async resumeSession(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return false;
    }

    const targetState =
      session.state === ConversationState.INTERRUPTED
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
      await this.clearUserActiveSessionIfMatches(session.userId, sessionId);

      this.logger.log(`Terminated voice session ${sessionId}`);
      return true;
    } catch (error) {
      this.logger.error(`Error terminating session ${sessionId}:`, error);
      return false;
    }
  }

  async getUserActiveSessions(userId: string): Promise<VoiceSession[]> {
    try {
      const sessionIds = await this.redisService.client.sMembers(
        this.USER_SESSIONS_PREFIX + userId,
      );
      const sessions = await Promise.all(
        sessionIds.map((id) => this.getSession(id)),
      );

      return sessions.filter(
        (session): session is VoiceSession => session !== null,
      );
    } catch (error) {
      this.logger.error(`Error retrieving user sessions for ${userId}:`, error);
      return [];
    }
  }

  async updateSessionSocket(
    sessionId: string,
    socketId: string,
  ): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return false;
    }

    session.socketId = socketId;
    session.lastActivityAt = new Date();

    await this.saveSession(session);
    return true;
  }

  // ---------------------------------------------------------------------------
  // AC-1 — Redis-backed user-session active pointer
  // ---------------------------------------------------------------------------

  async setUserActiveSession(userId: string, sessionId: string): Promise<void> {
    await this.redisService.client.setEx(
      this.USER_ACTIVE_SESSION_PREFIX + userId,
      this.USER_SESSION_POINTER_TTL,
      sessionId,
    );
  }

  async getUserActiveSession(userId: string): Promise<string | null> {
    return this.redisService.client.get(
      this.USER_ACTIVE_SESSION_PREFIX + userId,
    );
  }

  async deleteUserActiveSession(userId: string): Promise<void> {
    await this.redisService.client.del(
      this.USER_ACTIVE_SESSION_PREFIX + userId,
    );
  }

  async refreshUserSessionTTL(userId: string): Promise<void> {
    await this.redisService.refreshTTL(
      this.USER_ACTIVE_SESSION_PREFIX + userId,
      this.USER_SESSION_POINTER_TTL,
    );
  }

  // ---------------------------------------------------------------------------
  // AC-2 — Heartbeat ping tracking
  // ---------------------------------------------------------------------------

  async updateLastPingAt(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return false;
    }

    session.lastPingAt = new Date();
    session.lastActivityAt = new Date();

    await this.saveSession(session);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Cleanup — AC-2 (stale) + existing TTL-based
  // ---------------------------------------------------------------------------

  async cleanupStaleSessions(): Promise<number> {
    const now = Date.now();
    let cleanedCount = 0;

    try {
      const keys = await this.redisService.scanKeys(this.SESSION_PREFIX + '*');

      for (const key of keys) {
        const sessionData = await this.redisService.client.get(key);
        if (!sessionData) continue;

        const session = JSON.parse(sessionData) as VoiceSession;

        if (
          session.state === ConversationState.TERMINATED ||
          session.state === ConversationState.STALE
        ) {
          continue;
        }

        const lastPingMs = session.lastPingAt
          ? new Date(session.lastPingAt).getTime()
          : new Date(session.createdAt).getTime();

        if (now - lastPingMs > HEARTBEAT_TIMEOUT_MS) {
          const sessionId = key.replace(this.SESSION_PREFIX, '');
          this.logger.warn(
            `Session ${sessionId} is stale (no ping for ${Math.round((now - lastPingMs) / 1000)}s); terminating`,
          );
          await this.terminateSession(sessionId);
          cleanedCount++;
        }
      }
    } catch (error) {
      this.logger.error('Error during stale session cleanup:', error);
    }

    if (cleanedCount > 0) {
      this.logger.log(`Cleaned up ${cleanedCount} stale sessions`);
    }

    return cleanedCount;
  }

  async cleanupExpiredSessions(): Promise<number> {
    const now = Date.now();
    let cleanedCount = 0;

    try {
      const keys = await this.redisService.scanKeys(this.SESSION_PREFIX + '*');

      for (const key of keys) {
        const sessionData = await this.redisService.client.get(key);
        if (!sessionData) continue;

        const session = JSON.parse(sessionData);
        const lastActivity = new Date(session.lastActivityAt).getTime();
        const ttl = session.ttl * 1000;

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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async saveSession(session: VoiceSession): Promise<void> {
    const sessionData = JSON.stringify(session);
    await this.redisService.client.setEx(
      this.SESSION_PREFIX + session.id,
      session.ttl,
      sessionData,
    );
  }

  private async addUserSession(
    userId: string,
    sessionId: string,
  ): Promise<void> {
    await this.redisService.client.sAdd(
      this.USER_SESSIONS_PREFIX + userId,
      sessionId,
    );
    await this.redisService.client.expire(
      this.USER_SESSIONS_PREFIX + userId,
      this.SESSION_TTL,
    );
  }

  private async removeUserSession(
    userId: string,
    sessionId: string,
  ): Promise<void> {
    await this.redisService.client.sRem(
      this.USER_SESSIONS_PREFIX + userId,
      sessionId,
    );
  }

  private async clearUserActiveSessionIfMatches(
    userId: string,
    sessionId: string,
  ): Promise<void> {
    const current = await this.getUserActiveSession(userId);
    if (current === sessionId) {
      await this.deleteUserActiveSession(userId);
    }
  }
}
