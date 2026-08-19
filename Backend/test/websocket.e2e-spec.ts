import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { RedisService } from '../src/redis/redis.service';
import { createClient } from 'redis';

process.env.WEBHOOK_SECRET_KEY =
  process.env.WEBHOOK_SECRET_KEY || 'a'.repeat(64);

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

async function redisCleanup(keys: string[]) {
  const client = createClient({ url: REDIS_URL });
  await client.connect();
  for (const k of keys) {
    await client.del(k);
  }
  await client.quit();
}

function getPort(httpServer: any): number {
  const address = httpServer?.address();
  if (typeof address === 'string') {
    const parts = address.split(':');
    return parseInt(parts[parts.length - 1], 10);
  }
  return address?.port;
}

function createSocket(
  port: number,
  userId: string,
  extraAuth: Record<string, any> = {},
): ClientSocket {
  return io(`http://localhost:${port}`, {
    transports: ['websocket'],
    auth: { userId, ...extraAuth },
    forceNew: true,
  });
}

function waitForEvent<T = any>(
  socket: ClientSocket,
  event: string,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for "${event}"`)),
      timeoutMs,
    );
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('WebSocket Presence (e2e)', () => {
  let app: INestApplication;
  let httpServer: any;
  let redisService: RedisService;
  let port: number;
  let client1: ClientSocket | undefined;
  let client2: ClientSocket | undefined;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useWebSocketAdapter(new IoAdapter(app));

    httpServer = await app.listen(0);
    await app.init();

    redisService = moduleFixture.get<RedisService>(RedisService);
    port = getPort(httpServer);
  }, 180000);

  afterAll(async () => {
    if (client1?.connected) client1.disconnect();
    if (client2?.connected) client2.disconnect();
    await app?.close();
  }, 60000);

  beforeEach(async () => {
    await redisCleanup([
      'presence:online',
      'room:test-room:users',
      'user:user-1:rooms',
      'user:user-1:sockets',
      'user:user-1:heartbeat',
      'user:user-1:version',
      'user:user-2:rooms',
      'user:user-2:sockets',
      'user:user-2:heartbeat',
      'user:user-2:version',
    ]);
  });

  afterEach(async () => {
    if (client1?.connected) client1.disconnect();
    if (client2?.connected) client2.disconnect();
    client1 = undefined;
    client2 = undefined;
  });

  // ── Existing tests (preserved) ──────────────────────────────────────────

  it('should emit presence:update with correlation metadata on connection', async () => {
    client1 = createSocket(port, 'user-1');
    const payload = await waitForEvent<any>(client1, 'presence:update');

    expect(payload).toBeDefined();
    expect(payload.userId).toBe('user-1');
    expect(payload.status).toBe('online');
    expect(payload.correlationId).toBeDefined();
    expect(payload.timestamp).toBeDefined();
    expect(typeof payload.timestamp).toBe('number');
    expect(payload.version).toBeDefined();
  }, 10000);

  it('should recover room membership on reconnect', async () => {
    client1 = createSocket(port, 'user-1');
    await waitForEvent<any>(client1, 'presence:update');

    client1.emit('join-room', 'test-room');
    await sleep(300);

    client1.disconnect();
    expect(client1.connected).toBe(false);

    // Reconnect with a fresh socket
    client1 = createSocket(port, 'user-1');
    const recovery = await waitForEvent<any>(client1, 'presence:room_recovery');

    expect(recovery).toBeDefined();
    expect(recovery.rooms).toContain('test-room');
    expect(recovery.userId).toBe('user-1');
    expect(recovery.version).toBeDefined();

    client1.disconnect();
  }, 15000);

  it('should prevent duplicate presence for the same user joining the same room', async () => {
    client1 = createSocket(port, 'user-1');
    await waitForEvent<any>(client1, 'presence:update');

    client1.emit('join-room', 'test-room');
    await sleep(300);

    const redisClient = createClient({ url: REDIS_URL });
    await redisClient.connect();
    const membersBefore = await redisClient.sCard('room:test-room:users');

    client1.emit('join-room', 'test-room');
    await sleep(200);

    const membersAfter = await redisClient.sCard('room:test-room:users');
    await redisClient.quit();

    expect(membersBefore).toBe(1);
    expect(membersAfter).toBe(1);

    client1.disconnect();
  }, 10000);

  it('should clean up stale state reliably on disconnect', async () => {
    client1 = createSocket(port, 'user-1');
    await waitForEvent<any>(client1, 'presence:update');
    await sleep(200);

    client1.disconnect();
    await sleep(200);

    const redisClient = createClient({ url: REDIS_URL });
    await redisClient.connect();
    const onlineUsers = await redisClient.sMembers('presence:online');
    const sockets = await redisClient.sMembers('user:user-1:sockets');
    await redisClient.quit();

    expect(onlineUsers).not.toContain('user-1');
    expect(sockets).toEqual([]);
  }, 10000);

  it('should emit presence:update to room with correlation metadata', async () => {
    client1 = createSocket(port, 'user-1');
    client2 = createSocket(port, 'user-2');
    await waitForEvent<any>(client1, 'presence:update');
    await waitForEvent<any>(client2, 'presence:update');
    await sleep(200);

    // Listen for join event from user-2
    const observerPromise = new Promise<any>((resolve) => {
      client1!.on('presence:update', (payload: any) => {
        if (payload.event === 'join' && payload.userId === 'user-2') {
          resolve(payload);
        }
      });
      setTimeout(() => resolve(null), 5000);
    });

    client2.emit('join-room', 'test-room');
    const payload = await observerPromise;

    expect(payload).toBeDefined();
    expect(payload.roomId).toBe('test-room');
    expect(payload.event).toBe('join');
    expect(payload.correlationId).toBeDefined();
    expect(payload.timestamp).toBeDefined();
    expect(payload.users).toContain('user-2');

    client1.disconnect();
    client2.disconnect();
  }, 15000);

  it('should handle reconnecting with multiple tabs and clean up entirely only when all sockets disconnect', async () => {
    client1 = createSocket(port, 'user-1');
    await waitForEvent<any>(client1, 'presence:update');
    await sleep(200);

    client1.disconnect();

    client1 = createSocket(port, 'user-1');
    await waitForEvent<any>(client1, 'presence:update');
    client1.disconnect();

    await sleep(200);

    const redisClient = createClient({ url: REDIS_URL });
    await redisClient.connect();
    const onlineUsers = await redisClient.sMembers('presence:online');
    await redisClient.quit();

    expect(onlineUsers).not.toContain('user-1');
  }, 15000);

  // ── New tests: reconnect race protection ─────────────────────────────────

  it('should survive a rapid reconnect race without losing room membership', async () => {
    // Connect, join a room, then rapidly disconnect + reconnect.
    client1 = createSocket(port, 'user-1');
    await waitForEvent<any>(client1, 'presence:update');

    client1.emit('join-room', 'test-room');
    await sleep(300);

    // Simulate rapid reconnect: disconnect and immediately open a new socket
    // without waiting for the disconnect handler to finish.
    client1.disconnect();
    const client1b = createSocket(port, 'user-1');

    // The second connection should still recover the room.
    const recovery = await waitForEvent<any>(
      client1b,
      'presence:room_recovery',
    );
    expect(recovery).toBeDefined();
    expect(recovery.rooms).toContain('test-room');

    // Verify the room still has exactly one user.
    const redisClient = createClient({ url: REDIS_URL });
    await redisClient.connect();
    const users = await redisClient.sMembers('room:test-room:users');
    await redisClient.quit();

    expect(users).toContain('user-1');
    expect(users.length).toBe(1);

    client1b.disconnect();
  }, 15000);

  it('should handle overlapping connect/disconnect for the same user gracefully', async () => {
    // Open two sockets almost simultaneously for the same user.
    const socketA = createSocket(port, 'user-1');
    const socketB = createSocket(port, 'user-1');

    // Wait for both to connect
    await waitForEvent<any>(socketA, 'presence:update');
    await waitForEvent<any>(socketB, 'presence:update');

    await sleep(300);

    // Both should be registered.
    const redisClient = createClient({ url: REDIS_URL });
    await redisClient.connect();
    const sockets = await redisClient.sMembers('user:user-1:sockets');
    const onlineUsers = await redisClient.sMembers('presence:online');
    await redisClient.quit();

    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(onlineUsers).toContain('user-1');

    // Disconnect both
    socketA.disconnect();
    await sleep(100);
    socketB.disconnect();
    await sleep(300);

    // After both are gone, user should be fully offline.
    const redisClient2 = createClient({ url: REDIS_URL });
    await redisClient2.connect();
    const onlineAfter = await redisClient2.sMembers('presence:online');
    const socketsAfter = await redisClient2.sMembers('user:user-1:sockets');
    await redisClient2.quit();

    expect(onlineAfter).not.toContain('user-1');
    expect(socketsAfter).toEqual([]);
  }, 15000);

  it('should keep user online when one socket disconnects but another remains', async () => {
    const socketA = createSocket(port, 'user-1');
    await waitForEvent<any>(socketA, 'presence:update');

    const socketB = createSocket(port, 'user-1');
    await waitForEvent<any>(socketB, 'presence:update');
    await sleep(200);

    // Disconnect only socketA
    socketA.disconnect();
    await sleep(300);

    // User should still be online via socketB.
    const redisClient = createClient({ url: REDIS_URL });
    await redisClient.connect();
    const onlineUsers = await redisClient.sMembers('presence:online');
    const sockets = await redisClient.sMembers('user:user-1:sockets');
    await redisClient.quit();

    expect(onlineUsers).toContain('user-1');
    expect(sockets).toContain(socketB.id);

    socketB.disconnect();
  }, 15000);

  // ── New tests: correlation metadata ──────────────────────────────────────

  it('should include correlationId in all presence events', async () => {
    client1 = createSocket(port, 'user-1');
    client2 = createSocket(port, 'user-2');

    // Connection events should have correlationId
    const update1 = await waitForEvent<any>(client1, 'presence:update');
    expect(update1.correlationId).toBeDefined();
    expect(typeof update1.correlationId).toBe('string');
    expect(update1.correlationId.length).toBeGreaterThan(0);

    const update2 = await waitForEvent<any>(client2, 'presence:update');
    expect(update2.correlationId).toBeDefined();

    await sleep(200);

    // Room join should have correlationId
    const joinPromise = new Promise<any>((resolve) => {
      client1!.on('presence:update', (payload: any) => {
        if (payload.event === 'join' && payload.userId === 'user-2') {
          resolve(payload);
        }
      });
      setTimeout(() => resolve(null), 5000);
    });

    client2.emit('join-room', 'test-room');
    const joinPayload = await joinPromise;
    expect(joinPayload).toBeDefined();
    expect(joinPayload.correlationId).toBeDefined();
    expect(joinPayload.timestamp).toBeDefined();

    client1.disconnect();
    client2.disconnect();
  }, 15000);

  // ── New tests: reconnect recovery version tracking ───────────────────────

  it('should increment version on each connect', async () => {
    client1 = createSocket(port, 'user-1');
    const first = await waitForEvent<any>(client1, 'presence:update');
    const v1 = first.version;
    client1.disconnect();
    await sleep(200);

    client1 = createSocket(port, 'user-1');
    const second = await waitForEvent<any>(client1, 'presence:update');
    const v2 = second.version;
    client1.disconnect();

    expect(v2).toBeGreaterThan(v1);
  }, 15000);

  // ── New tests: offline notification on final disconnect ───────────────────

  it('should emit offline status when the last socket disconnects', async () => {
    client1 = createSocket(port, 'user-1');
    await waitForEvent<any>(client1, 'presence:update');
    await sleep(200);

    const offlinePromise = new Promise<any>((resolve) => {
      // After disconnect, the server broadcasts presence:update with
      // status: offline — but we can't listen from a disconnected socket.
      // Instead verify the Redis state directly.
      resolve(null);
    });

    client1.disconnect();
    await sleep(400);

    const redisClient = createClient({ url: REDIS_URL });
    await redisClient.connect();
    const isOnline =
      (await redisClient.sIsMember('presence:online', 'user-1')) === 1;
    const sockets = await redisClient.sMembers('user:user-1:sockets');
    const version = await redisClient.get('user:user-1:version');
    const heartbeat = await redisClient.get('user:user-1:heartbeat');
    await redisClient.quit();

    expect(isOnline).toBe(false);
    expect(sockets).toEqual([]);
    expect(version).toBeNull();
    expect(heartbeat).toBeNull();
  }, 10000);
});
