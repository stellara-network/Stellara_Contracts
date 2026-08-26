import { createClient } from 'redis';
import { buildRedisUrl } from './redis.config';

/**
 * Standalone Redis client used outside of the NestJS DI container
 * (e.g., TypeORM migrations, scripts, queue processors that run before the
 * app module is bootstrapped).
 *
 * Errors are logged with the Redis URL masked so that passwords embedded in
 * connection strings are never exposed in application logs.
 */

/** Minimal inline masker for use before DI is available. */
function maskRedisUrl(url: string): string {
  // Replace password in redis://:password@host or redis://user:password@host
  return url.replace(
    /(rediss?:\/\/[^:@\s]*:)[^@\s]+(@)/gi,
    '$1***$2',
  );
}

export const redisClient = createClient({
  url: buildRedisUrl(),
});

redisClient.on('error', (err: Error) => {
  // Strip any Redis URL that may have been embedded in the error message
  const safeMessage = maskRedisUrl(err.message);
  console.error('Redis error:', safeMessage);
});

export async function connectRedis() {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
}
