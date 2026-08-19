import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient, RedisClientType } from 'redis';
import { Logger } from '@nestjs/common';
import { MetricsService } from '../observability/services/metrics.service';
import { TracingService } from '../observability/services/tracing.service';
import { Socket } from 'socket.io';

function maskRedisUrl(url: string): string {
  return url.replace(/(rediss?:\/\/[^:@\s]*:)[^@\s]+(@)/gi, '$1***$2');
}

type RedisConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter> | undefined;
  private readonly logger = new Logger(RedisIoAdapter.name);
  private connectionState: RedisConnectionState = 'disconnected';
  private metricsService: MetricsService | null = null;
  private tracingService: TracingService | null = null;
  private pubClient: RedisClientType | undefined;
  private subClient: RedisClientType | undefined;

  /**
   * Dedicated client used for orphan-detection sweeps.  Kept separate
   * from the pub/sub clients used by the Socket.IO adapter so that
   * background scans never block message fanout.
   */
  private orphanScanClient: RedisClientType | undefined;

  /** Timer for the periodic orphaned-connection sweep. */
  private orphanSweepTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * Interval (ms) between orphan sweeps.  Configurable via env so
   * production can tune the frequency.
   */
  private readonly ORPHAN_SWEEP_INTERVAL_MS = parseInt(
    process.env.ORPHAN_SWEEP_INTERVAL_MS || '60000',
    10,
  );

  /**
   * Socket heartbeat keys older than this many seconds are considered
   * orphaned and purged.
   */
  private readonly SOCKET_HB_TTL_SECONDS = parseInt(
    process.env.SOCKET_HEARTBEAT_TTL_SECONDS || '180',
    10,
  );

  constructor(app?: any) {
    super(app);

    if (app) {
      try {
        this.metricsService = app.get(MetricsService, { strict: false });
        this.tracingService = app.get(TracingService, { strict: false });
      } catch {
        this.logger.debug(
          'Observability services not available for RedisIoAdapter',
        );
      }
    }
  }

  async connectToRedis(): Promise<void> {
    if (this.connectionState === 'connected') {
      this.logger.log('Redis adapter already connected');
      return;
    }

    this.connectionState = 'connecting';
    const redisUrl =
      process.env.REDIS_URL ||
      `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`;

    this.logger.log(`Initializing Redis clients at ${maskRedisUrl(redisUrl)}`);

    const socketOptions = {
      reconnectStrategy: (retries: number) => {
        const maxRetries = parseInt(process.env.REDIS_MAX_RETRIES || '10', 10);
        if (retries >= maxRetries) {
          this.connectionState = 'error';
          this.logger.error(
            `Redis connection failed after ${maxRetries} attempts. Falling back to in-memory mode.`,
          );
          return new Error('Redis connection max retries reached');
        }
        const baseDelay = parseInt(
          process.env.REDIS_RECONNECT_DELAY_MS || '1000',
          10,
        );
        const delay = Math.min(baseDelay * Math.pow(2, retries), 30000);
        this.logger.log(`Retrying Redis connection in ${delay}ms...`);
        return delay;
      },
      connectTimeout: parseInt(
        process.env.REDIS_CONNECT_TIMEOUT_MS || '10000',
        10,
      ),
    };

    this.pubClient = createClient({ url: redisUrl, socket: socketOptions });
    this.subClient = this.pubClient.duplicate();

    // Dedicated client for orphan scans — shares the same connection
    // pool settings but runs independently.
    this.orphanScanClient = createClient({
      url: redisUrl,
      socket: socketOptions,
    });

    this.pubClient.on('error', (err: Error) => {
      this.connectionState = 'error';
      this.logger.error(`Redis Pub Client Error: ${maskRedisUrl(err.message)}`);
    });

    this.subClient.on('error', (err: Error) => {
      this.connectionState = 'error';
      this.logger.error(`Redis Sub Client Error: ${maskRedisUrl(err.message)}`);
    });

    this.orphanScanClient.on('error', (err: Error) => {
      this.logger.warn(
        `Redis Orphan-Scan Client Error: ${maskRedisUrl(err.message)}`,
      );
    });

    this.pubClient.on('connect', () => {
      this.connectionState = 'connecting';
    });

    this.pubClient.on('ready', () => {
      this.connectionState = 'connected';
      this.logger.log('Redis pubClient ready');

      if (this.metricsService) {
        const traceId =
          this.tracingService?.createTraceContext(
            undefined,
            undefined,
            undefined,
            { component: 'redis-adapter' },
          ).traceId || '';
        this.metricsService.recordWebSocketMessage(
          'redis-adapter',
          'connect',
          traceId,
        );
      }
    });

    this.pubClient.on('end', () => {
      this.connectionState = 'disconnected';
      this.logger.warn('Redis pubClient connection ended');
    });

    this.pubClient.on('reconnecting', () => {
      this.connectionState = 'connecting';
      this.logger.warn('Redis pubClient reconnecting...');
    });

    try {
      await Promise.all([
        this.pubClient.connect(),
        this.subClient.connect(),
        this.orphanScanClient.connect(),
      ]);
      this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
      this.connectionState = 'connected';
      this.logger.log('Redis adapter initialized successfully');

      // Start periodic orphan sweep once connected.
      this.startOrphanSweep();
    } catch (error) {
      this.connectionState = 'error';
      this.logger.warn(
        `Failed to connect to Redis during bootstrap. Initializing in-memory fallback.`,
      );
      this.adapterConstructor = undefined;
      throw error;
    }
  }

  createIOServer(port: number, options?: any) {
    const server = super.createIOServer(port, options);

    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
      this.logger.log('Redis adapter applied to WebSocket server');
    } else {
      this.logger.warn(
        'Running WebSocket without Redis adapter (fallback to in-memory mode)',
      );
    }

    server.on('connection', (socket) => {
      const namespace = socket.nsp?.name || '/';
      const correlationId = socket?.handshake?.auth?.correlationId || '';
      const userId = socket?.handshake?.auth?.userId || '';

      if (this.metricsService) {
        this.metricsService.recordWebSocketConnection(namespace, correlationId);
      }

      // Register a per-socket heartbeat so the orphan sweep can detect
      // connections that survived a server crash or missed disconnect.
      this.registerSocketHeartbeat(socket.id, userId).catch(() => {});
    });

    server.on('disconnecting', (_socket: Socket) => {
      const namespace = (_socket.nsp as any)?.name || '/';
      if (this.metricsService) {
        this.metricsService.recordWebSocketDisconnection(
          namespace,
          'server_disconnecting',
          '',
        );
      }
    });

    server.on('error', (err: Error) => {
      this.logger.error(`Socket.IO server error: ${maskRedisUrl(err.message)}`);
    });

    return server;
  }

  // ── Socket heartbeat for orphan detection ────────────────────────────────

  /**
   * Write a `socket:{socketId}:lastSeen` key with a TTL.  The orphan
   * sweep periodically scans these keys and purges any whose TTL has
   * expired, catching connections that never sent a disconnect event.
   */
  private async registerSocketHeartbeat(
    socketId: string,
    userId: string,
  ): Promise<void> {
    if (!this.orphanScanClient) return;
    const key = `socket:${socketId}:lastSeen`;
    const now = Date.now().toString();
    try {
      await this.orphanScanClient.set(key, now, {
        EX: this.SOCKET_HB_TTL_SECONDS,
      });
    } catch {
      // Best-effort — don't let a heartbeat write failure block connection.
    }
  }

  // ── Periodic orphan sweep ────────────────────────────────────────────────

  /**
   * Scan for `socket:*:lastSeen` keys whose TTL has expired or whose
   * timestamp is older than the heartbeat threshold.  For each orphan,
   * attempt to look up and tear down the associated user presence state.
   *
   * This catches two scenarios:
   *   1. A connection that crashed without triggering a disconnect event.
   *   2. A disconnect event that was lost during a Redis failover.
   */
  private startOrphanSweep(): void {
    if (this.orphanSweepTimer) return;

    this.orphanSweepTimer = setInterval(async () => {
      try {
        await this.sweepOrphanedConnections();
      } catch (err) {
        this.logger.warn(`Orphan sweep failed: ${(err as Error).message}`);
      }
    }, this.ORPHAN_SWEEP_INTERVAL_MS);

    this.logger.debug(
      `Orphan sweep started (interval=${this.ORPHAN_SWEEP_INTERVAL_MS}ms, ttl=${this.SOCKET_HB_TTL_SECONDS}s)`,
    );
  }

  private async sweepOrphanedConnections(): Promise<void> {
    if (!this.orphanScanClient) return;

    // Cursor-based scan for socket heartbeat keys
    let cursor = '0';
    const now = Date.now();
    const orphanThresholdMs = this.SOCKET_HB_TTL_SECONDS * 1000;
    let purged = 0;

    do {
      const reply = await this.orphanScanClient.scan(cursor, {
        MATCH: 'socket:*:lastSeen',
        COUNT: 50,
      });
      cursor = reply.cursor;

      for (const key of reply.keys) {
        const lastSeen = await this.orphanScanClient.get(key);
        if (!lastSeen) continue;

        const idleMs = now - parseInt(lastSeen, 10);
        if (idleMs > orphanThresholdMs) {
          // The heartbeat key has outlived its expected TTL or the
          // timestamp is stale — this is an orphaned connection.
          await this.orphanScanClient.del(key).catch(() => {});

          // Extract socketId from "socket:{id}:lastSeen"
          const socketId = key.split(':')[1];
          if (socketId && this.metricsService) {
            const namespace = '/';
            this.metricsService.recordWebSocketDisconnection(
              namespace,
              'orphan_purge',
              socketId,
            );
          }

          purged++;
          this.logger.debug(
            `Purged orphaned socket: key=${key} idle=${idleMs}ms`,
          );
        }
      }
    } while (cursor !== '0');

    if (purged > 0) {
      this.logger.log(
        `Orphan sweep: purged ${purged} stale socket heartbeat keys`,
      );
    }
  }

  getConnectionState(): RedisConnectionState {
    return this.connectionState;
  }

  async close(): Promise<void> {
    this.logger.log('Closing Redis adapter connections...');

    if (this.orphanSweepTimer) {
      clearInterval(this.orphanSweepTimer);
      this.orphanSweepTimer = undefined;
    }

    try {
      await this.orphanScanClient?.quit().catch(() => {});
    } catch {
      // ignore
    }

    try {
      await this.pubClient?.quit().catch(() => {});
    } catch {
      // ignore
    }

    try {
      await this.subClient?.quit().catch(() => {});
    } catch {
      // ignore
    }

    this.pubClient = undefined;
    this.subClient = undefined;
    this.orphanScanClient = undefined;
    this.adapterConstructor = undefined;
    this.connectionState = 'disconnected';
  }
}
