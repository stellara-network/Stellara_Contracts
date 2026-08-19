import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, UseGuards } from '@nestjs/common';
import { VoiceSessionService } from './services/voice-session.service';
import { StreamingResponseService } from './services/streaming-response.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { VoiceMessageDto } from './dto/voice-message.dto';
import { SessionActionDto } from './dto/session-action.dto';
import { ConversationState } from './types/conversation-state.enum';
import { WsJwtAuthGuard } from '../auth/guards/ws-jwt-auth.guard';
import { WebSocketTracingAdapter } from '../observability/middleware/websocket-tracing.adapter';

const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:3000', 'http://localhost:3001'];

@WebSocketGateway({
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
  namespace: '/voice',
})
export class VoiceGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(VoiceGateway.name);

  constructor(
    private readonly voiceSessionService: VoiceSessionService,
    private readonly streamingResponseService: StreamingResponseService,
    private readonly webSocketTracingAdapter: WebSocketTracingAdapter,
  ) {}

  async handleConnection(client: Socket) {
    const userId = client.data.user?.sub || client.data.user?.userId;
    const sessionId = client.handshake.auth.sessionId;

    if (!userId) {
      this.logger.warn(
        `Voice client rejected: No user ID in token from ${client.id}`,
      );
      client.emit('voice:error', { message: 'Authentication failed' });
      client.disconnect();
      return;
    }

    // Initialize tracing for this connection
    const traceContext = this.webSocketTracingAdapter.initializeConnection(
      client,
      '/voice',
    );
    if (userId) {
      // Update trace context with user ID if available
      traceContext.userId = userId;
    }

    this.logger.log(`Voice client connected: ${client.id}, userId: ${userId}`);

    if (sessionId) {
      const session = await this.voiceSessionService.getSession(sessionId);
      if (session && session.userId === userId) {
        await this.voiceSessionService.updateSessionSocket(
          sessionId,
          client.id,
        );
        await this.voiceSessionService.resumeSession(sessionId);
        client.join(sessionId);
        await this.voiceSessionService.setUserActiveSession(userId, sessionId);
        client.emit('voice:resumed', { sessionId, state: session.state });
        this.logger.log(
          `Resumed voice session ${sessionId} for user ${userId}`,
        );
      } else {
        client.emit('voice:error', { message: 'Invalid session' });
        client.disconnect();
      }
    }
  }

  async handleDisconnect(client: Socket) {
    const userId = client.data.user?.sub || client.data.user?.userId;
    const sessionId = client.handshake.auth.sessionId;

    this.webSocketTracingAdapter.handleDisconnection(
      client.id,
      '/voice',
      'client disconnect',
    );

    this.logger.log(
      `Voice client disconnected: ${client.id}, userId: ${userId}`,
    );

    if (userId && sessionId) {
      await this.voiceSessionService.updateSessionState(
        sessionId,
        ConversationState.IDLE,
      );
      await this.voiceSessionService.deleteUserActiveSession(userId);
    }
  }

  @UseGuards(WsJwtAuthGuard)
  @SubscribeMessage('voice:create-session')
  async createSession(
    @ConnectedSocket() client: Socket,
    @MessageBody() createSessionDto: CreateSessionDto,
  ) {
    try {
      this.webSocketTracingAdapter.recordMessage(
        client.id,
        '/voice',
        'voice:create-session',
      );

      const userId = client.data.user?.sub || client.data.user?.userId;
      if (!userId) {
        client.emit('voice:error', { message: 'Authentication required' });
        return;
      }

      const existingSessions =
        await this.voiceSessionService.getUserActiveSessions(userId);
      if (existingSessions.length > 0) {
        const existingSession = existingSessions[0];
        await this.voiceSessionService.updateSessionSocket(
          existingSession.id,
          client.id,
        );
        client.join(existingSession.id);
        await this.voiceSessionService.setUserActiveSession(
          userId,
          existingSession.id,
        );
        client.emit('voice:session-created', { session: existingSession });
        return;
      }

      let session;
      try {
        session = await this.voiceSessionService.createSession(
          createSessionDto.userId,
          createSessionDto.context,
          createSessionDto.walletAddress,
          createSessionDto.metadata,
        );
      } catch (err: any) {
        if (err.message?.includes('Session limit reached')) {
          client.emit('voice:error', {
            code: 'SESSION_LIMIT_REACHED',
            message: err.message,
          });
          return;
        }
        throw err;
      }

      await this.voiceSessionService.updateSessionSocket(session.id, client.id);
      client.join(session.id);
      await this.voiceSessionService.setUserActiveSession(userId, session.id);

      client.emit('voice:session-created', { session });
      this.logger.log(`Created voice session ${session.id} for user ${userId}`);
    } catch (error) {
      this.logger.error('Error creating session:', error);
      client.emit('voice:error', { message: 'Failed to create session' });
    }
  }

  @UseGuards(WsJwtAuthGuard)
  @SubscribeMessage('voice:message')
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() messageDto: VoiceMessageDto,
  ) {
    try {
      this.webSocketTracingAdapter.recordMessage(
        client.id,
        '/voice',
        'voice:message',
      );

      const userId = client.data.user?.sub || client.data.user?.userId;
      const sessionId =
        await this.voiceSessionService.getUserActiveSession(userId);

      if (!sessionId) {
        client.emit('voice:error', { message: 'No active session' });
        return;
      }

      const session = await this.voiceSessionService.getSession(sessionId);
      if (!session || session.userId !== userId) {
        client.emit('voice:error', { message: 'Invalid session' });
        return;
      }

      const streamId =
        await this.streamingResponseService.startStreamingResponse(
          this.server,
          sessionId,
          messageDto.content,
        );

      this.logger.log(
        `Started streaming response ${streamId} for session ${sessionId}`,
      );
    } catch (error) {
      this.logger.error('Error handling message:', error);
      client.emit('voice:error', { message: 'Failed to process message' });
    }
  }

  @UseGuards(WsJwtAuthGuard)
  @SubscribeMessage('voice:interrupt')
  async handleInterrupt(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId?: string },
  ) {
    try {
      this.webSocketTracingAdapter.recordMessage(
        client.id,
        '/voice',
        'voice:interrupt',
      );

      const userId = client.data.user?.sub || client.data.user?.userId;
      const sessionId =
        await this.voiceSessionService.getUserActiveSession(userId);

      if (!sessionId) {
        client.emit('voice:error', { message: 'No active session' });
        return;
      }

      const success = await this.streamingResponseService.interruptStream(
        this.server,
        sessionId,
        data.streamId,
      );

      if (success) {
        client.emit('voice:interrupt-acknowledged', {
          sessionId,
          streamId: data.streamId,
        });
      } else {
        client.emit('voice:error', { message: 'Failed to interrupt' });
      }
    } catch (error) {
      this.logger.error('Error handling interrupt:', error);
      client.emit('voice:error', { message: 'Failed to interrupt' });
    }
  }

  @UseGuards(WsJwtAuthGuard)
  @SubscribeMessage('voice:action')
  async handleSessionAction(
    @ConnectedSocket() client: Socket,
    @MessageBody() actionDto: SessionActionDto,
  ) {
    try {
      this.webSocketTracingAdapter.recordMessage(
        client.id,
        '/voice',
        'voice:action',
      );

      const userId = client.data.user?.sub || client.data.user?.userId;
      const sessionId =
        await this.voiceSessionService.getUserActiveSession(userId);

      if (!sessionId) {
        client.emit('voice:error', { message: 'No active session' });
        return;
      }

      if (actionDto.interrupt) {
        await this.streamingResponseService.interruptStream(
          this.server,
          sessionId,
        );
      }

      if (actionDto.state) {
        const success = await this.voiceSessionService.updateSessionState(
          sessionId,
          actionDto.state,
        );
        if (success) {
          client.emit('voice:state-updated', {
            sessionId,
            state: actionDto.state,
          });
        } else {
          client.emit('voice:error', { message: 'Invalid state transition' });
        }
      }
    } catch (error) {
      this.logger.error('Error handling session action:', error);
      client.emit('voice:error', { message: 'Failed to perform action' });
    }
  }

  @UseGuards(WsJwtAuthGuard)
  @SubscribeMessage('voice:terminate')
  async handleTerminate(@ConnectedSocket() client: Socket) {
    try {
      this.webSocketTracingAdapter.recordMessage(
        client.id,
        '/voice',
        'voice:terminate',
      );

      const userId = client.data.user?.sub || client.data.user?.userId;
      const sessionId =
        await this.voiceSessionService.getUserActiveSession(userId);

      if (!sessionId) {
        client.emit('voice:error', { message: 'No active session' });
        return;
      }

      await this.streamingResponseService.interruptStream(
        this.server,
        sessionId,
      );

      const success =
        await this.voiceSessionService.terminateSession(sessionId);

      if (success) {
        client.leave(sessionId);
        await this.voiceSessionService.deleteUserActiveSession(userId);
        client.emit('voice:terminated', { sessionId });
        this.logger.log(
          `Terminated voice session ${sessionId} for user ${userId}`,
        );
      } else {
        client.emit('voice:error', { message: 'Failed to terminate session' });
      }
    } catch (error) {
      this.logger.error('Error terminating session:', error);
      client.emit('voice:error', { message: 'Failed to terminate session' });
    }
  }

  @UseGuards(WsJwtAuthGuard)
  @SubscribeMessage('voice:ping')
  async handlePing(@ConnectedSocket() client: Socket) {
    this.webSocketTracingAdapter.recordMessage(
      client.id,
      '/voice',
      'voice:ping',
    );

    const userId = client.data.user?.sub || client.data.user?.userId;
    const sessionId =
      await this.voiceSessionService.getUserActiveSession(userId);

    if (sessionId) {
      await this.voiceSessionService.updateSessionSocket(sessionId, client.id);
      await this.voiceSessionService.updateLastPingAt(sessionId);
      await this.voiceSessionService.refreshUserSessionTTL(userId);
    }

    client.emit('voice:pong', { timestamp: Date.now() });
  }
}
