export type RedisEnvironment = Record<string, unknown>;

export function buildRedisUrl(env: RedisEnvironment = process.env): string {
  if (typeof env.REDIS_URL === 'string' && env.REDIS_URL.length > 0) {
    return env.REDIS_URL;
  }

  const host = String(env.REDIS_HOST || 'localhost');
  const port = String(env.REDIS_PORT || 6379);
  const password = env.REDIS_PASSWORD ? `:${encodeURIComponent(String(env.REDIS_PASSWORD))}@` : '';
  return `redis://${password}${host}:${port}`;
}

export function buildBullRedisOptions(env: RedisEnvironment = process.env) {
  const url = new URL(buildRedisUrl(env));
  const configuredDb = env.REDIS_QUEUE_DB;
  const db = configuredDb === undefined
    ? (url.pathname ? Number.parseInt(url.pathname.slice(1), 10) || 1 : 1)
    : Number.parseInt(String(configuredDb), 10);

  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    db,
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}