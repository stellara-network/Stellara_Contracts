import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ConfigDto } from './config.dto';

/**
 * Validate raw environment values before the rest of the Nest application is
 * created. This function intentionally has no DI or logging dependencies so it
 * can be used by ConfigModule.forRoot's `validate` hook.
 */
export function validateEnvironment(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const config = plainToInstance(ConfigDto, values, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(config, {
    whitelist: true,
    forbidNonWhitelisted: false,
  });
  const messages = errors.flatMap((error) =>
    Object.values(error.constraints ?? {}),
  );

  if (!values.REDIS_URL && !values.REDIS_HOST) {
    messages.push(
      'Redis configuration missing: set REDIS_URL or (REDIS_HOST + REDIS_PORT)',
    );
  }

  const nodeEnv = values.NODE_ENV;
  if (nodeEnv === 'production') {
    const jwtSecret = String(values.JWT_SECRET ?? '');
    const dbPassword = String(values.DB_PASSWORD ?? '');
    const weakSecrets = [
      'default-secret-change-in-production',
      'secret',
      'password',
      'changeme',
      'change-in-production',
      'your-super-secret-jwt-key-change-in-production',
    ];

    if (weakSecrets.includes(jwtSecret)) {
      messages.push('Production environment detected with weak or default JWT_SECRET. Set a strong, unique secret for production.');
    }
    if (weakSecrets.includes(dbPassword)) {
      messages.push('Production environment detected with weak or default DB_PASSWORD. Set a strong, unique secret for production.');
    }
    if (jwtSecret && jwtSecret.length < 32) {
      messages.push(`JWT_SECRET must be at least 32 characters long in production (got ${jwtSecret.length})`);
    }
    if (dbPassword && dbPassword.length < 16) {
      messages.push(`DB_PASSWORD must be at least 16 characters long in production (got ${dbPassword.length})`);
    }
  }

  if (messages.length > 0) {
    throw new Error(`Configuration validation failed: ${messages.join('; ')}`);
  }

  return values;
}