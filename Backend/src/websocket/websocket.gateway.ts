import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import { PresenceService } from './presence.service';
import { MetricsService } from '../observability/services/metrics.service';
import { TracingService } from '../observability/services/tracing.service';

@WebSocketGateway({
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
})
export class WebsocketGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(WebsocketGateway.name);

  /**
   * Per-user mutex that serialises reconnect processing.  Without this,
   * a rapid reconnect (close → open in < 100 ms) can interleave with the
   * previous connection's disconnect handler and corrupt room state.
   *
   * The map stores a Promise that resolves when the current connect or
   * disconnect for that user finishes.  New operations chain onto it.
   */
  private userLocks = new Map<string, Promise<void>>();

  /**
   * Mapping from socketId → userId so that handleDisconnect can look up
   * the user even after the handshake auth is no longer available.
   */
  private socketToUser = new Map<string, string>();

  /** Interval handle for the periodic orphan-purge sweep. */
  private orphanPurgeTimer: ReturnType<typeof setInterval> | undefined;

  /** How often (ms) to sweep for orphaned socket heartbeat keys. */
  private readonly ORPHAN_PURGE_INTERVAL_MS = parseInt(
    process.env.ORPHAN_PURGE_INTERVAL_MS || '60000',
    10,
  );

  constructor(
    private readonly presenceService: PresenceService,
    private readonly metricsService: MetricsService,
    private readonly tracingService: TracingService,
  ) {}

  // ── Lifecycle ────────────────────────────────────────────────────────────

  onModuleInit() {
    // Start a periodic sweep that removes socket heartbeat keys whose TTL
    // has expired — catching orphaned registrations from crashes or missed
    // disconnect events.
    this.orphanPurgeTimer = setInterval(() => {
      this.presenceService.purgeOrphanedSockets().catch((err) => {
        this.logger.warn(`Orphan purge failed: ${err.message}`);
      });
    }, this.ORPHAN_PURGE_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.orphanPurgeTimer) {
      clearInterval(this.orphanPurgeTimer);
    }
  }

  // ── Connection / Disconnect with per-user locking ───────────────────────

  async handleConnection(client: Socket) {
    const userId = client.handshake.auth.userId;
    if (!userId) {
      this.logger.warn(
        `WS connection rejected: missing userId from ${client.id}`,
      );
      client.emit('auth:error', { message: 'userId is required' });
      client.disconnect();
      return;
    }

    // Acquire per-user lock so that a rapid reconnect is serialised
    // against the in-flight disconnect of the previous socket.
    const prev = this.userLocks.get(userId) ?? Promise.resolve();
    const current = prev.then(
      () => this._processConnection(client, userId),
      () => this._processConnection(client, userId), // proceed even if prior op failed
    );
    this.userLocks.set(userId, current);

    try {
      await current;
    } finally {
      // Release the lock only if we are still the latest pending op.
      if (this.userLocks.get(userId) === current) {
        this.userLocks.delete(userId);
      }
    }
  }

  private async _processConnection(client: Socket, userId: string) {
    const correlationId = client.handshake.auth.correlationId || randomUUID();
    const namespace = (client.nsp as any)?.name || '/';

    this.metricsService.recordWebSocketConnection(namespace, correlationId);

    const traceContext = this.tracingService.createTraceContext(
      undefined,
      undefined,
      userId,
      { correlationId, socketId: client.id, type: 'connection' },
    );

    // Atomic connect: registers the socket, bumps version, sets heartbeat.
    const version = await this.presenceService.userConnected(
      userId,
      client.id,
      traceContext.traceId,
    );

    // Record socket→userId mapping for disconnect lookup.
    this.socketToUser.set(client.id, userId);

    // Recover any rooms the user was in before the previous connection.
    const rooms = await this.presenceService.getUserRooms(userId);
    const joinedRooms: string[] = [];

    for (const roomId of rooms) {
      try {
        client.join(roomId);
        joinedRooms.push(roomId);
      } catch {
        this.metricsService.recordWebSocketMessage(
          namespace,
          'recover_room_error',
          correlationId,
        );
      }
    }

    if (joinedRooms.length > 0) {
      this.server.to(userId).emit('presence:room_recovery', {
        userId,
        rooms: joinedRooms,
        version,
        correlationId: traceContext.traceId,
        timestamp: Date.now(),
      });
    }

    this.server.to(userId).emit('presence:update', {
      userId,
      status: 'online',
      socketId: client.id,
      version,
      rooms: joinedRooms,
      correlationId: traceContext.traceId,
      timestamp: Date.now(),
    });

    this.logger.log(
      `WS connection: userId=${userId} socket=${client.id} version=${version} rooms=${JSON.stringify(joinedRooms)}`,
    );
  }

  async handleDisconnect(client: Socket) {
    const userId =
      this.socketToUser.get(client.id) ?? client.handshake.auth.userId;

    // Clean up the mapping regardless of whether we find the user.
    this.socketToUser.delete(client.id);

    if (!userId) return;

    const correlationId = randomUUID();
    const namespace = (client.nsp as any)?.name || '/';

    // Acquire per-user lock — serialise with any in-flight reconnect.
    const prev = this.userLocks.get(userId) ?? Promise.resolve();
    const current = prev.then(
      () => this._processDisconnect(client, userId, correlationId, namespace),
      () => this._processDisconnect(client, userId, correlationId, namespace),
    );
    this.userLocks.set(userId, current);

    try {
      await current;
    } finally {
      if (this.userLocks.get(userId) === current) {
        this.userLocks.delete(userId);
      }
    }
  }

  private async _processDisconnect(
    client: Socket,
    userId: string,
    correlationId: string,
    namespace: string,
  ) {
    this.metricsService.recordWebSocketDisconnection(
      namespace,
      'client_disconnect',
      correlationId,
    );

    // Atomic disconnect: removes socket, tears down presence only if no
    // sockets remain. Returns true if the user is now fully offline.
    const fullyDisconnected = await this.presenceService.userDisconnected(
      userId,
      client.id,
      correlationId,
    );

    if (fullyDisconnected) {
      this.server.to(userId).emit('presence:update', {
        userId,
        status: 'offline',
        socketId: client.id,
        correlationId,
        timestamp: Date.now(),
      });
    } else {
      // User still has other sockets open — notify with reduced update.
      const socketCount = await this.presenceService.getSocketCount(userId);
      this.server.to(userId).emit('presence:update', {
        userId,
        status: 'connected',
        socketId: client.id,
        socketCount,
        correlationId,
        timestamp: Date.now(),
      });
    }
  }

  // ── Room commands ──────────────────────────────────────────────────────

  @SubscribeMessage('join-room')
  async joinRoom(client: Socket, roomId: string) {
    const userId = client.handshake.auth.userId;
    if (!userId) {
      client.emit('auth:error', { message: 'userId is required' });
      return;
    }

    const correlationId = randomUUID();
    const namespace = (client.nsp as any)?.name || '/';

    this.metricsService.recordWebSocketMessage(
      namespace,
      'join_room',
      correlationId,
    );

    // Refresh socket-level heartbeat so orphan detection knows it's alive.
    await this.presenceService.refreshSocketHeartbeat(client.id);

    await this.presenceService.joinRoom(userId, roomId, correlationId);
    void client.join(roomId);

    await this.presenceService.heartbeat(userId);

    const users = await this.presenceService.getRoomUsers(roomId);
    this.server.to(roomId).emit('presence:update', {
      roomId,
      users,
      correlationId,
      timestamp: Date.now(),
      event: 'join',
      userId,
    });
  }

  @SubscribeMessage('leave-room')
  async leaveRoom(client: Socket, roomId: string) {
    const userId = client.handshake.auth.userId;
    if (!userId) {
      client.emit('auth:error', { message: 'userId is required' });
      return;
    }

    const correlationId = randomUUID();
    const namespace = (client.nsp as any)?.name || '/';

    this.metricsService.recordWebSocketMessage(
      namespace,
      'leave_room',
      correlationId,
    );

    await this.presenceService.refreshSocketHeartbeat(client.id);

    await this.presenceService.leaveRoom(userId, roomId, correlationId);
    void client.leave(roomId);

    await this.presenceService.heartbeat(userId);

    const users = await this.presenceService.getRoomUsers(roomId);
    this.server.to(roomId).emit('presence:update', {
      roomId,
      users,
      correlationId,
      timestamp: Date.now(),
      event: 'leave',
      userId,
    });
  }

  @SubscribeMessage('presence:heartbeat')
  async handleHeartbeat(client: Socket) {
    const userId = client.handshake.auth.userId;
    if (!userId) return;

    // Refresh both user-level and socket-level heartbeats.
    await this.presenceService.heartbeat(userId);
    await this.presenceService.refreshSocketHeartbeat(client.id);
    client.emit('presence:pong', { timestamp: Date.now() });
  }

  @SubscribeMessage('message')
  handleMessage(client: Socket, payload: { roomId: string; message: string }) {
    const userId = client.handshake.auth.userId;
    if (!userId) {
      client.emit('auth:error', { message: 'userId is required' });
      return;
    }

    const correlationId = randomUUID();
    const namespace = (client.nsp as any)?.name || '/';

    this.metricsService.recordWebSocketMessage(
      namespace,
      'message',
      correlationId,
    );

    const traceContext = this.tracingService.createTraceContext(
      undefined,
      undefined,
      userId,
      { correlationId, roomId: payload.roomId },
    );

    // Fire-and-forget heartbeat refresh so the message path stays fast.
    void this.presenceService.heartbeat(userId);
    void this.presenceService.refreshSocketHeartbeat(client.id);

    this.server.to(payload.roomId).emit('message', {
      ...payload,
      userId,
      correlationId: traceContext.traceId,
      timestamp: Date.now(),
    });
  }
}
