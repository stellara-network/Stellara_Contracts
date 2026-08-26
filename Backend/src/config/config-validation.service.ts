import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ConfigDto } from './config.dto';
import { SecretsMaskingService } from './secrets-masking.service';

export interface ValidationResult {
  success: boolean;
  errors: string[];
  warnings: string[];
}

@Injectable()
export class ConfigValidationService {
  private readonly logger = new Logger(ConfigValidationService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly maskingService: SecretsMaskingService,
  ) {}

  /**
   * Validate all environment variables against the ConfigDto schema.
   * Returns a structured result for programmatic use by StartupValidationService.
   */
  validate(): ValidationResult {
    const isProduction = this.configService.get('NODE_ENV') === 'production';
    const errors: string[] = [];
    const warnings: string[] = [];

    // Build env vars object from ConfigService
    const envVars = this.buildEnvVarsMap();

    // Class-validator against ConfigDto schema
    const configDto = plainToInstance(ConfigDto, envVars, {
      enableImplicitConversion: true,
    });

    const classErrors = validateSync(configDto, {
      whitelist: true,
      forbidNonWhitelisted: false,
    });

    if (classErrors.length > 0) {
      for (const error of classErrors) {
        const constraints = Object.values(error.constraints || {});
        errors.push(...constraints);
      }
    }

    // ── Cross-field / business-rule validations ────────────────────────────

    // Redis: must have either REDIS_URL or REDIS_HOST
    const hasRedisUrl = !!envVars.REDIS_URL;
    const hasRedisHost = !!envVars.REDIS_HOST;
    if (!hasRedisUrl && !hasRedisHost) {
      errors.push(
        'Redis configuration missing: set REDIS_URL or (REDIS_HOST + REDIS_PORT)',
      );
    }

    // Database port sanity
    const dbPort = parseInt(String(envVars.DB_PORT || '5432'), 10);
    if (dbPort < 1 || dbPort > 65535) {
      errors.push(`DB_PORT must be between 1 and 65535, got ${dbPort}`);
    }

    // REDIS_PORT sanity
    if (envVars.REDIS_PORT) {
      const redisPort = parseInt(String(envVars.REDIS_PORT), 10);
      if (redisPort < 1 || redisPort > 65535) {
        errors.push(`REDIS_PORT must be between 1 and 65535, got ${redisPort}`);
      }
    }

    // PORT sanity
    if (envVars.PORT) {
      const port = parseInt(String(envVars.PORT), 10);
      if (port < 1 || port > 65535) {
        errors.push(`PORT must be between 1 and 65535, got ${port}`);
      }
    }

    // Queue concurrency sanity
    const queueConcurrencyVars = [
      'QUEUE_DEPLOY_CONTRACT_CONCURRENCY',
      'QUEUE_PROCESS_TTS_CONCURRENCY',
      'QUEUE_INDEX_MARKET_NEWS_CONCURRENCY',
    ] as const;
    for (const key of queueConcurrencyVars) {
      const val = envVars[key];
      if (val !== undefined) {
        const num = parseInt(String(val), 10);
        if (isNaN(num) || num < 1 || num > 50) {
          errors.push(`${key} must be between 1 and 50, got "${val}"`);
        }
      }
    }

    // NODE_ENV validation
    const validEnvs = ['development', 'staging', 'production', 'test'];
    const nodeEnv = envVars.NODE_ENV;
    if (nodeEnv && !validEnvs.includes(nodeEnv)) {
      errors.push(
        `NODE_ENV must be one of [${validEnvs.join(', ')}], got "${nodeEnv}"`,
      );
    }

    // WEBHOOK_SECRET_KEY hex validation
    const webhookKey = envVars.WEBHOOK_SECRET_KEY;
    if (webhookKey && !/^[0-9a-f]{64}$/i.test(webhookKey)) {
      errors.push(
        'WEBHOOK_SECRET_KEY must be a 64-character hexadecimal string (32 bytes)',
      );
    }

    // Stellar URL validation
    const horizonUrl = envVars.HORIZON_URL;
    if (horizonUrl && !horizonUrl.startsWith('http')) {
      errors.push(`HORIZON_URL must start with http:// or https://, got "${horizonUrl}"`);
    }

    const stellarRpcUrl = envVars.STELLAR_RPC_URL;
    if (stellarRpcUrl && !stellarRpcUrl.startsWith('http')) {
      errors.push(
        `STELLAR_RPC_URL must start with http:// or https://, got "${stellarRpcUrl}"`,
      );
    }

    // Warnings for production-specific issues
    if (isProduction) {
      this.validateProductionSecrets(envVars, errors, warnings);
    }

    // ── Log results ─────────────────────────────────────────────────────────
    if (errors.length > 0) {
      const safeMessages = this.maskingService.mask(errors.join('; '));
      this.logger.error(`Configuration validation failed (${errors.length} error(s)): ${safeMessages}`);
      throw new Error(
        `Configuration validation failed: ${safeMessages}\n` +
          'Please check your environment variables. See .env.example for documentation.',
      );
    }

    if (warnings.length > 0) {
      for (const warning of warnings) {
        this.logger.warn(this.maskingService.mask(warning));
      }
    }

    this.logger.log(
      `Configuration validation passed (${Object.keys(envVars).filter(k => envVars[k] !== undefined).length} env vars checked)`,
    );

    return { success: true, errors, warnings };
  }

  /**
   * Build a map of all environment variables to validate.
   */
  private buildEnvVarsMap(): Record<string, string | undefined> {
    const keys = [
      // Core
      'NODE_ENV', 'PORT',
      // Auth
      'JWT_SECRET', 'JWT_ACCESS_EXPIRATION', 'JWT_REFRESH_EXPIRATION',
      // Database
      'DB_HOST', 'DB_PORT', 'DB_USERNAME', 'DB_PASSWORD', 'DB_DATABASE',
      // Redis
      'REDIS_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD', 'REDIS_QUEUE_DB',
      // Queue
      'QUEUE_DEPLOY_CONTRACT_CONCURRENCY', 'QUEUE_PROCESS_TTS_CONCURRENCY',
      'QUEUE_INDEX_MARKET_NEWS_CONCURRENCY', 'QUEUE_DEFAULT_ATTEMPTS',
      'QUEUE_DEFAULT_BACKOFF_DELAY', 'QUEUE_KEEP_COMPLETED_JOBS',
      'QUEUE_KEEP_FAILED_JOBS', 'QUEUE_DEBUG_LOGGING', 'QUEUE_EVENT_TRACKING',
      'QUEUE_DLQ_RETENTION_DAYS',
      // Stellar
      'HORIZON_URL', 'STELLAR_RPC_URL', 'STELLAR_NETWORK_PASSPHRASE',
      'STELLAR_MONITOR_ENABLED',
      // Webhook
      'WEBHOOK_SECRET_KEY',
      // Secrets
      'VAULT_ENABLED', 'VAULT_ADDR', 'VAULT_NAMESPACE', 'VAULT_TOKEN',
      'AWS_SECRETS_MANAGER_ENABLED',
      // Rate limiting
      'RATE_LIMIT_LOGIN', 'RATE_LIMIT_REFRESH', 'RATE_LIMIT_API', 'RATE_LIMIT_WINDOW',
      // External
      'LLM_API_KEY', 'LLM_BASE_URL',
      // Swagger / Debug
      'SWAGGER_ENABLED', 'DEBUG',
      // CORS
      'CORS_ORIGINS',
      // Startup validation
      'STARTUP_CHECK_TIMEOUT_MS', 'STARTUP_FAIL_ON_DB_ERROR',
    ];

    const envVars: Record<string, string | undefined> = {};
    for (const key of keys) {
      envVars[key] = this.configService.get(key);
    }
    return envVars;
  }

  /**
   * Validate secrets for production environment.
   */
  private validateProductionSecrets(
    envVars: Record<string, string | undefined>,
    errors: string[],
    warnings: string[],
  ): void {
    const jwtSecret = envVars.JWT_SECRET;
    const dbPassword = envVars.DB_PASSWORD;

    // Check for default/weak secrets in production
    const weakSecrets: Array<{ name: string; value: string | undefined; label: string }> = [
      { name: 'JWT_SECRET', value: jwtSecret, label: 'JWT_SECRET' },
      { name: 'DB_PASSWORD', value: dbPassword, label: 'DB_PASSWORD' },
    ];

    const defaultPatterns = [
      'default-secret-change-in-production',
      'secret',
      'password',
      'changeme',
      'change-in-production',
      'your-super-secret-jwt-key-change-in-production',
    ];

    for (const secret of weakSecrets) {
      if (secret.value && defaultPatterns.includes(secret.value)) {
        errors.push(
          `Production environment detected with weak or default ${secret.label}. ` +
            'Set strong, unique secrets for production.',
        );
      }
    }

    // Minimum length checks (only in production)
    if (jwtSecret && jwtSecret.length < 32) {
      errors.push(
        `JWT_SECRET must be at least 32 characters long in production (got ${jwtSecret.length})`,
      );
    }

    if (dbPassword && dbPassword.length < 16) {
      errors.push(
        `DB_PASSWORD must be at least 16 characters long in production (got ${dbPassword.length})`,
      );
    }

    // VAULT should be enabled in production
    if (envVars.VAULT_ENABLED !== 'true') {
      warnings.push(
        'VAULT_ENABLED is not true in production. Secrets should be managed via Vault or AWS Secrets Manager.',
      );
    }

    // Warn if plaintext secrets are set in production env (not via Vault)
    if (envVars.VAULT_TOKEN && envVars.VAULT_ENABLED !== 'true') {
      warnings.push(
        'VAULT_TOKEN is set but VAULT_ENABLED is not true. Consider enabling Vault for secrets management.',
      );
    }
  }
}
