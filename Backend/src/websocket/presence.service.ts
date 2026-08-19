import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/**
 * Lua script: atomic disconnect — removes a socket from the user's socket
 * set, and only if no sockets remain does it tear down room memberships,
 * online status, heartbeat, and version keys. This prevents the classic
 * reconnect race where a late disconnect cleans up a freshly-reconnected
 * socket.
 *
 * KEYS[1] = user:{userId}:sockets
 * KEYS[2] = presence:online
 * KEYS[3] = user:{userId}:version
 * KEYS[4] = user:{userId}:heartbeat
 * KEYS[5] = user:{userId}:rooms
 * ARGV[1] = socketId to remove
 *
 * Returns: 1 if fully disconnected (no remaining sockets), 0 if sockets remain
 */
const LUA_DISCONNECT_SCRIPT = `
local sockets_key = KEYS[1]
local online_key  = KEYS[2]
local version_key = KEYS[3]
local hb_key      = KEYS[4]
local rooms_key   = KEYS[5]
local socket_id   = ARGV[1]

redis.call('SREM', sockets_key, socket_id)

local remaining = redis.call('SCARD', sockets_key)

if remaining == 0 then
  -- Fully offline: tear down everything atomically
  redis.call('DEL', sockets_key)
  redis.call('SREM', online_key, KEYS[6])
  redis.call('DEL', version_key)
  redis.call('DEL', hb_key)

  -- Remove user from all room member sets
  local rooms = redis.call('SMEMBERS', rooms_key)
  for _, room_id in ipairs(rooms) do
    redis.call('SREM', 'room:' .. room_id .. ':users', KEYS[6])
  end
  redis.call('DEL', rooms_key)

  return 1
else
  -- Other sockets still alive: just refresh TTL
  redis.call('EXPIRE', sockets_key, tonumber(ARGV[2]))
  return 0
end
`;

/**
 * Lua script: atomic connect — registers a socket, ensures online presence,
 * bumps the version counter, and sets the heartbeat — all in one round-trip.
 *
 * Returns the new version number.
 *
 * KEYS[1] = user:{userId}:sockets
 * KEYS[2] = presence:online
 * KEYS[3] = user:{userId}:version
 * KEYS[4] = user:{userId}:heartbeat
 * ARGV[1] = socketId
 * ARGV[2] = presence TTL (seconds)
 * ARGV[3] = heartbeat TTL (seconds)
 * ARGV[4] = userId
 */
const LUA_CONNECT_SCRIPT = `
local sockets_key = KEYS[1]
local online_key  = KEYS[2]
local version_key = KEYS[3]
local hb_key      = KEYS[4]
local socket_id   = ARGV[1]
local pres_ttl    = tonumber(ARGV[2])
local hb_ttl      = tonumber(ARGV[3])
local user_id     = ARGV[4]

local added = redis.call('SADD', sockets_key, socket_id)
redis.call('EXPIRE', sockets_key, pres_ttl)
redis.call('SADD', online_key, user_id)
redis.call('EXPIRE', online_key, pres_ttl + 3600)

local new_version = redis.call('INCR', version_key)
redis.call('EXPIRE', version_key, pres_ttl + 3600)

redis.call('SET', hb_key, ARGV[5], 'EX', hb_ttl)

return new_version
`;

/**
 * Lua script: atomic room join — adds user to room and room to user's room
 * set in a single round-trip, with TTL refresh.
 *
 * KEYS[1] = user:{userId}:rooms
 * KEYS[2] = room:{roomId}:users
 * ARGV[1] = roomId
 * ARGV[2] = userId
 * ARGV[3] = room TTL (seconds)
 */
const LUA_JOIN_ROOM_SCRIPT = `
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
redis.call('SADD', KEYS[2], ARGV[2])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
return 1
`;

/**
 * Lua script: atomic room leave — removes user from room and room from
 * user's room set atomically.
 *
 * KEYS[1] = user:{userId}:rooms
 * KEYS[2] = room:{roomId}:users
 * ARGV[1] = roomId
 * ARGV[2] = userId
 */
const LUA_LEAVE_ROOM_SCRIPT = `
redis.call('SREM', KEYS[1], ARGV[1])
redis.call('SREM', KEYS[2], ARGV[2])
return 1
`;

@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);
  private readonly PRESENCE_TTL = parseInt(
    process.env.PRESENCE_TTL_SECONDS || '300',
    10,
  );
  private readonly ROOM_TTL = parseInt(
    process.env.ROOM_TTL_SECONDS || '3600',
    10,
  );
  private readonly HEARTBEAT_TTL = parseInt(
    process.env.HEARTBEAT_TTL_SECONDS || '120',
    10,
  );
  private readonly SOCKET_HEARTBEAT_TTL = parseInt(
    process.env.SOCKET_HEARTBEAT_TTL_SECONDS || '180',
    10,
  );
  private readonly ORPHAN_PURGE_INTERVAL_MS = parseInt(
    process.env.ORPHAN_PURGE_INTERVAL_MS || '60000',
    10,
  );

  constructor(private readonly redis: RedisService) {}

  private key(...parts: string[]): string {
    return parts.join(':');
  }

  // ── Atomic connect / disconnect ─────────────────────────────────────────

  /**
   * Atomically register a new socket for `userId`. Uses a Lua script so
   * that the socket set update, online presence, version bump, and
   * heartbeat write all happen in a single Redis round-trip — eliminating
   * race windows where a concurrent disconnect could see a partial state.
   *
   * @returns The new monotonic version number for this user's presence.
   */
  async userConnected(
    userId: string,
    socketId: string,
    correlationId?: string,
  ): Promise<number> {
    const socketsKey = this.key('user', userId, 'sockets');
    const onlineKey = this.key('presence:online');
    const versionKey = this.key('user', userId, 'version');
    const heartbeatKey = this.key('user', userId, 'heartbeat');
    const socketHbKey = this.key('socket', socketId, 'lastSeen');

    const now = Date.now().toString();

    const version = await this.redis.evalScript<number>(
      LUA_CONNECT_SCRIPT,
      [socketsKey, onlineKey, versionKey, heartbeatKey],
      [socketId, this.PRESENCE_TTL, this.HEARTBEAT_TTL, userId, now],
    );

    // Track per-socket heartbeat for orphan detection (separate key with
    // its own TTL so stale sockets can be found independently).
    await this.redis.client.set(socketHbKey, now, {
      EX: this.SOCKET_HEARTBEAT_TTL,
    });

    this.logger.debug(
      `User connected: userId=${userId} socket=${socketId} version=${version} correlationId=${correlationId || 'n/a'}`,
    );

    return version;
  }

  /**
   * Atomically remove a socket and, if no sockets remain for the user,
   * tear down all presence state (online flag, rooms, heartbeat, version).
   *
   * Uses a Lua script so that the "are there remaining sockets?" check and
   * the subsequent cleanup happen atomically — preventing the reconnect
   * race where a late disconnect wipes out a freshly-reconnected socket.
   *
   * @returns true if the user was fully disconnected (no sockets left).
   */
  async userDisconnected(
    userId: string,
    socketId: string,
    correlationId?: string,
  ): Promise<boolean> {
    const socketsKey = this.key('user', userId, 'sockets');
    const onlineKey = this.key('presence:online');
    const versionKey = this.key('user', userId, 'version');
    const heartbeatKey = this.key('user', userId, 'heartbeat');
    const roomsKey = this.key('user', userId, 'rooms');
    const socketHbKey = this.key('socket', socketId, 'lastSeen');

    // Remove per-socket heartbeat key
    await this.redis.client.del(socketHbKey);

    const result = await this.redis.evalScript<number>(
      LUA_DISCONNECT_SCRIPT,
      [socketsKey, onlineKey, versionKey, heartbeatKey, roomsKey, userId],
      [socketId, this.PRESENCE_TTL],
    );

    if (result === 1) {
      this.logger.debug(
        `User fully disconnected: userId=${userId} correlationId=${correlationId || 'n/a'}`,
      );
      return true;
    }

    this.logger.debug(
      `Socket removed but user remains connected: userId=${userId} socket=${socketId}`,
    );
    return false;
  }

  // ── Atomic room join / leave ────────────────────────────────────────────

  async joinRoom(userId: string, roomId: string, correlationId?: string) {
    const userRoomsKey = this.key('user', userId, 'rooms');
    const roomUsersKey = this.key('room', roomId, 'users');

    await this.redis.evalScript(
      LUA_JOIN_ROOM_SCRIPT,
      [userRoomsKey, roomUsersKey],
      [roomId, userId, this.ROOM_TTL],
    );

    this.logger.debug(
      `User joined room: userId=${userId} roomId=${roomId} correlationId=${correlationId || 'n/a'}`,
    );
  }

  async leaveRoom(userId: string, roomId: string, correlationId?: string) {
    const userRoomsKey = this.key('user', userId, 'rooms');
    const roomUsersKey = this.key('room', roomId, 'users');

    await this.redis.evalScript(
      LUA_LEAVE_ROOM_SCRIPT,
      [userRoomsKey, roomUsersKey],
      [roomId, userId],
    );

    this.logger.debug(
      `User left room: userId=${userId} roomId=${roomId} correlationId=${correlationId || 'n/a'}`,
    );
  }

  // ── Heartbeats ─────────────────────────────────────────────────────────

  async heartbeat(userId: string) {
    const heartbeatKey = this.key('user', userId, 'heartbeat');
    await this.redis.client.set(heartbeatKey, Date.now().toString(), {
      EX: this.HEARTBEAT_TTL,
    });
  }

  /**
   * Refresh the per-socket heartbeat timestamp. Call this on every inbound
   * message from a socket so that orphan detection can distinguish idle
   * but alive sockets from truly orphaned ones.
   */
  async refreshSocketHeartbeat(socketId: string): Promise<void> {
    const socketHbKey = this.key('socket', socketId, 'lastSeen');
    await this.redis.client.set(socketHbKey, Date.now().toString(), {
      EX: this.SOCKET_HEARTBEAT_TTL,
    });
  }

  // ── Queries ────────────────────────────────────────────────────────────

  async getRoomUsers(roomId: string): Promise<string[]> {
    return this.redis.client.sMembers(this.key('room', roomId, 'users'));
  }

  async getUserRooms(userId: string): Promise<string[]> {
    return this.redis.client.sMembers(this.key('user', userId, 'rooms'));
  }

  async getOnlineUsers(): Promise<string[]> {
    return this.redis.client.sMembers('presence:online');
  }

  async getUserVersion(userId: string): Promise<string | null> {
    return this.redis.client.get(this.key('user', userId, 'version'));
  }

  /**
   * Return the number of live sockets registered for `userId`.
   */
  async getSocketCount(userId: string): Promise<number> {
    return this.redis.client.sCard(this.key('user', userId, 'sockets'));
  }

  /**
   * Check whether `userId` is in the online presence set.
   */
  async isUserOnline(userId: string): Promise<boolean> {
    return (await this.redis.client.sIsMember('presence:online', userId)) === 1;
  }

  // ── Orphan detection & stale cleanup ────────────────────────────────────

  /**
   * Purge sockets whose per-socket heartbeat key has expired or is about
   * to expire.  This catches orphaned socket registrations that survived
   * a disconnect race or server crash.
   *
   * @returns The socket IDs that were purged.
   */
  async purgeOrphanedSockets(): Promise<string[]> {
    // Scan for socket:*:lastSeen keys
    const pattern = this.key('socket', '*', 'lastSeen');
    const keys = await this.redis.scanKeys(pattern);

    if (keys.length === 0) return [];

    const now = Date.now();
    const purged: string[] = [];

    for (const key of keys) {
      const lastSeen = await this.redis.client.get(key);
      if (!lastSeen) continue;

      const idleMs = now - parseInt(lastSeen, 10);
      if (idleMs > this.SOCKET_HEARTBEAT_TTL * 1000) {
        // Extract socketId from key: "socket:{socketId}:lastSeen"
        const socketId = key.split(':')[1];
        if (socketId) {
          purged.push(socketId);
          await this.redis.client.del(key);
          this.logger.debug(
            `Purged orphaned socket heartbeat: socket=${socketId} idle=${idleMs}ms`,
          );
        }
      }
    }

    return purged;
  }

  /**
   * Legacy cleanup method — scans for stale users (online but no
   * heartbeat) and tears down their state. Retained for backward
   * compatibility with scheduled tasks.
   */
  async cleanupStaleUsers(maxIdleSeconds: number = 300): Promise<string[]> {
    const onlineUsers = await this.getOnlineUsers();
    const now = Date.now();
    const staleUsers: string[] = [];

    for (const userId of onlineUsers) {
      const heartbeatKey = this.key('user', userId, 'heartbeat');
      const lastSeen = await this.redis.client.get(heartbeatKey);

      if (!lastSeen || now - parseInt(lastSeen, 10) > maxIdleSeconds * 1000) {
        staleUsers.push(userId);
      }
    }

    if (staleUsers.length > 0) {
      const pipeline = this.redis.client.multi();
      for (const userId of staleUsers) {
        pipeline.sRem('presence:online', userId);
        pipeline.del(this.key('user', userId, 'sockets'));
        pipeline.del(this.key('user', userId, 'heartbeat'));
        pipeline.del(this.key('user', userId, 'version'));
        pipeline.del(this.key('user', userId, 'rooms'));
      }
      await pipeline.exec();

      this.logger.log(
        `Cleaned up ${staleUsers.length} stale users: ${staleUsers.join(', ')}`,
      );
    }

    return staleUsers;
  }
}
