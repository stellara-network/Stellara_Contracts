import { validateEnvironment } from './environment-validation';

describe('validateEnvironment', () => {
  const validEnvironment = {
    NODE_ENV: 'development',
    JWT_SECRET: 'a-very-secure-secret-key-that-is-at-least-32-chars',
    DB_HOST: 'localhost',
    DB_PASSWORD: 'a-very-secure-db-password-16chars',
    REDIS_URL: 'redis://localhost:6379',
  };

  it('accepts a valid environment', () => {
    expect(validateEnvironment(validEnvironment)).toBe(validEnvironment);
  });

  it('rejects missing required configuration before module startup', () => {
    expect(() => validateEnvironment({
      ...validEnvironment,
      JWT_SECRET: undefined,
      DB_HOST: undefined,
      REDIS_URL: undefined,
    })).toThrow(/JWT_SECRET|DB_HOST|Redis configuration missing/);
  });

  it('rejects invalid queue and startup timeout values', () => {
    expect(() => validateEnvironment({
      ...validEnvironment,
      QUEUE_DEPLOY_CONTRACT_CONCURRENCY: '0',
      STARTUP_CHECK_TIMEOUT_MS: 'not-a-number',
    })).toThrow(/QUEUE_DEPLOY_CONTRACT_CONCURRENCY|STARTUP_CHECK_TIMEOUT_MS/);
  });

  it('rejects production default secrets', () => {
    expect(() => validateEnvironment({
      ...validEnvironment,
      NODE_ENV: 'production',
      JWT_SECRET: 'secret',
      DB_PASSWORD: 'password',
    })).toThrow(/weak or default/);
  });
});