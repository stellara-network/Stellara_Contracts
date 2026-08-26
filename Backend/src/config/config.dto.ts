import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  Min,
  Max,
  Matches,
  IsIn,
  IsBooleanString,
  IsNumberString,
} from 'class-validator';

export class ConfigDto {
  // ── Core ─────────────────────────────────────────────────────────────────
  @IsOptional()
  @IsIn(['development', 'staging', 'production', 'test'])
  NODE_ENV?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT?: number;

  // ── Authentication ───────────────────────────────────────────────────────
  @IsString()
  @IsNotEmpty()
  JWT_SECRET: string;

  @IsString()
  @IsOptional()
  JWT_ACCESS_EXPIRATION?: string;

  @IsString()
  @IsOptional()
  JWT_REFRESH_EXPIRATION?: string;

  // ── Database (PostgreSQL) ────────────────────────────────────────────────
  @IsString()
  @IsNotEmpty()
  DB_HOST: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  DB_PORT?: number;

  @IsString()
  @IsOptional()
  DB_USERNAME?: string;

  @IsString()
  @IsNotEmpty()
  DB_PASSWORD: string;

  @IsString()
  @IsOptional()
  DB_DATABASE?: string;

  // ── Redis ────────────────────────────────────────────────────────────────
  @IsString()
  @IsOptional()
  @Matches(/^rediss?:\/\//, {
    message: 'REDIS_URL must start with redis:// or rediss://',
  })
  REDIS_URL?: string;

  @IsString()
  @IsOptional()
  REDIS_HOST?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  REDIS_PORT?: number;

  @IsString()
  @IsOptional()
  REDIS_PASSWORD?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(15)
  REDIS_QUEUE_DB?: number;

  // ── Queue (Bull) ─────────────────────────────────────────────────────────
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  QUEUE_DEPLOY_CONTRACT_CONCURRENCY?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  QUEUE_PROCESS_TTS_CONCURRENCY?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  QUEUE_INDEX_MARKET_NEWS_CONCURRENCY?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  QUEUE_DEFAULT_ATTEMPTS?: number;

  @IsOptional()
  @IsInt()
  @Min(100)
  QUEUE_DEFAULT_BACKOFF_DELAY?: number;

  @IsOptional()
  @IsInt()
  QUEUE_KEEP_COMPLETED_JOBS?: number;

  @IsOptional()
  @IsInt()
  QUEUE_KEEP_FAILED_JOBS?: number;

  @IsOptional()
  @IsBooleanString()
  QUEUE_DEBUG_LOGGING?: string;

  @IsOptional()
  @IsBooleanString()
  QUEUE_EVENT_TRACKING?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  QUEUE_DLQ_RETENTION_DAYS?: number;

  // ── Stellar ──────────────────────────────────────────────────────────────
  @IsString()
  @IsOptional()
  @Matches(/^https?:\/\//, {
    message: 'HORIZON_URL must be a valid HTTP(S) URL',
  })
  HORIZON_URL?: string;

  @IsString()
  @IsOptional()
  @Matches(/^https?:\/\//, {
    message: 'STELLAR_RPC_URL must be a valid HTTP(S) URL',
  })
  STELLAR_RPC_URL?: string;

  @IsString()
  @IsOptional()
  STELLAR_NETWORK_PASSPHRASE?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  STELLAR_MONITOR_ENABLED?: string;

  // ── Webhook ──────────────────────────────────────────────────────────────
  @IsString()
  @IsOptional()
  @Matches(/^[0-9a-f]{64}$/i, {
    message: 'WEBHOOK_SECRET_KEY must be a 64-character hex string (32 bytes)',
  })
  WEBHOOK_SECRET_KEY?: string;

  // ── Secrets management ───────────────────────────────────────────────────
  @IsOptional()
  @IsIn(['true', 'false'])
  VAULT_ENABLED?: string;

  @IsString()
  @IsOptional()
  VAULT_ADDR?: string;

  @IsString()
  @IsOptional()
  VAULT_NAMESPACE?: string;

  @IsString()
  @IsOptional()
  VAULT_TOKEN?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  AWS_SECRETS_MANAGER_ENABLED?: string;

  // ── Rate limiting ────────────────────────────────────────────────────────
  @IsOptional()
  @IsInt()
  @Min(1)
  RATE_LIMIT_LOGIN?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  RATE_LIMIT_REFRESH?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  RATE_LIMIT_API?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  RATE_LIMIT_WINDOW?: number;

  // ── LLM / External ──────────────────────────────────────────────────────
  @IsString()
  @IsOptional()
  LLM_API_KEY?: string;

  @IsString()
  @IsOptional()
  LLM_BASE_URL?: string;

  // ── Swagger / Debug ──────────────────────────────────────────────────────
  @IsOptional()
  @IsIn(['true', 'false'])
  SWAGGER_ENABLED?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  DEBUG?: string;

  // ── CORS ─────────────────────────────────────────────────────────────────
  @IsString()
  @IsOptional()
  CORS_ORIGINS?: string;

  // ── Startup validation ──────────────────────────────────────────────────
  @IsOptional()
  @IsInt()
  @Min(100)
  STARTUP_CHECK_TIMEOUT_MS?: number;

  @IsOptional()
  @IsIn(['true', 'false'])
  STARTUP_FAIL_ON_DB_ERROR?: string;
}
