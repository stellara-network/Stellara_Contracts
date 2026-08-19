import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitFullSchema1783000000000 implements MigrationInterface {
  name = 'InitFullSchema1783000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE IF NOT EXISTS "public"."workflows_type_enum" AS ENUM('contract_deployment', 'trade_execution', 'ai_job_chain', 'indexing_verification', 'portfolio_update', 'reward_grant')`,
    );
    await queryRunner.query(
      `CREATE TYPE IF NOT EXISTS "public"."workflows_state_enum" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled', 'compensating', 'compensated')`,
    );
    await queryRunner.query(
      `CREATE TYPE IF NOT EXISTS "public"."workflow_steps_state_enum" AS ENUM('pending', 'running', 'completed', 'failed', 'skipped', 'compensating', 'compensated')`,
    );
    await queryRunner.query(
      `CREATE TYPE IF NOT EXISTS "public"."job_type_enum" AS ENUM('stt', 'tts')`,
    );
    await queryRunner.query(
      `CREATE TYPE IF NOT EXISTS "public"."job_status_enum" AS ENUM('pending', 'processing', 'completed', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TYPE IF NOT EXISTS "public"."feature_context_enum" AS ENUM('academy', 'trading', 'general', 'community')`,
    );
    await queryRunner.query(
      `CREATE TYPE IF NOT EXISTS "public"."conversation_state_enum" AS ENUM('listening', 'thinking', 'responding', 'interrupted', 'idle', 'stale', 'terminated')`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" varchar, "username" varchar, "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now(), "isActive" boolean NOT NULL DEFAULT true, CONSTRAINT "UQ_users_email" UNIQUE ("email"), CONSTRAINT "PK_users_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "wallet_bindings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "publicKey" varchar NOT NULL, "userId" varchar NOT NULL, "boundAt" timestamp NOT NULL DEFAULT now(), "isPrimary" boolean NOT NULL DEFAULT true, "lastUsed" timestamp, CONSTRAINT "UQ_wallet_bindings_publicKey" UNIQUE ("publicKey"), CONSTRAINT "PK_wallet_bindings_id" PRIMARY KEY ("id"), CONSTRAINT "FK_wallet_bindings_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_wallet_bindings_userId" ON "wallet_bindings" ("userId")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "login_nonces" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "nonce" varchar NOT NULL, "publicKey" varchar NOT NULL, "expiresAt" timestamp NOT NULL, "used" boolean NOT NULL DEFAULT false, "createdAt" timestamp NOT NULL DEFAULT now(), CONSTRAINT "UQ_login_nonces_nonce" UNIQUE ("nonce"), CONSTRAINT "PK_login_nonces_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "refresh_tokens" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "token" varchar NOT NULL, "userId" varchar NOT NULL, "expiresAt" timestamp NOT NULL, "revoked" boolean NOT NULL DEFAULT false, "revokedAt" timestamp, "createdAt" timestamp NOT NULL DEFAULT now(), CONSTRAINT "UQ_refresh_tokens_token" UNIQUE ("token"), CONSTRAINT "PK_refresh_tokens_id" PRIMARY KEY ("id"), CONSTRAINT "FK_refresh_tokens_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_refresh_tokens_userId" ON "refresh_tokens" ("userId")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "api_tokens" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "token" varchar NOT NULL, "name" varchar NOT NULL, "role" varchar NOT NULL, "userId" varchar NOT NULL, "expiresAt" timestamp, "revoked" boolean NOT NULL DEFAULT false, "lastUsedAt" timestamp, "createdAt" timestamp NOT NULL DEFAULT now(), CONSTRAINT "UQ_api_tokens_token" UNIQUE ("token"), CONSTRAINT "PK_api_tokens_id" PRIMARY KEY ("id"), CONSTRAINT "FK_api_tokens_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_api_tokens_userId" ON "api_tokens" ("userId")`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "workflows" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "idempotencyKey" varchar NOT NULL, "type" "public"."workflows_type_enum" NOT NULL, "state" "public"."workflows_state_enum" NOT NULL DEFAULT 'pending', "userId" varchar, "walletAddress" varchar, "input" jsonb NOT NULL, "output" jsonb, "context" jsonb, "currentStepIndex" integer NOT NULL DEFAULT '0', "totalSteps" integer NOT NULL DEFAULT '0', "startedAt" TIMESTAMP, "completedAt" TIMESTAMP, "failedAt" TIMESTAMP, "failureReason" varchar, "retryCount" integer NOT NULL DEFAULT '0', "maxRetries" integer NOT NULL DEFAULT '3', "nextRetryAt" TIMESTAMP, "requiresCompensation" boolean NOT NULL DEFAULT false, "isCompensated" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_619a202a61b92e73f20de8d29ed" UNIQUE ("idempotencyKey"), CONSTRAINT "PK_5b5757cc1cd86268019fef52e0c" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_e6b7312458454123287286afa6" ON "workflows" ("userId") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_15206576633d3e612da44c882d" ON "workflows" ("type") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_98afa5ee1ac04e690c908bbf85" ON "workflows" ("state") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_619a202a61b92e73f20de8d29e" ON "workflows" ("idempotencyKey") `,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "workflow_steps" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "workflowId" uuid NOT NULL, "stepName" varchar NOT NULL, "stepIndex" integer NOT NULL, "state" "public"."workflow_steps_state_enum" NOT NULL DEFAULT 'pending', "input" jsonb, "output" jsonb, "config" jsonb, "retryCount" integer NOT NULL DEFAULT '0', "maxRetries" integer NOT NULL DEFAULT '3', "startedAt" TIMESTAMP, "completedAt" TIMESTAMP, "failedAt" TIMESTAMP, "failureReason" varchar, "nextRetryAt" TIMESTAMP, "requiresCompensation" boolean NOT NULL DEFAULT false, "isCompensated" boolean NOT NULL DEFAULT false, "compensatedAt" TIMESTAMP, "compensationStepName" varchar, "compensationConfig" jsonb, "isIdempotent" boolean NOT NULL DEFAULT false, "idempotencyKey" varchar, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b602e5ecb22943db11c96a7f31c" PRIMARY KEY ("id"), CONSTRAINT "FK_eb0c057661503827a7cd6d8ea41" FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_5a56ecdb592cc9ed1924cd56eb" ON "workflow_steps" ("state") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_eb0c057661503827a7cd6d8ea4" ON "workflow_steps" ("workflowId") `,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "webhook_consumers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" varchar(100) NOT NULL, "url" varchar(500) NOT NULL, "secret" varchar(100), "status" varchar(20) NOT NULL DEFAULT 'active', "maxRetries" integer NOT NULL DEFAULT '5', "timeoutMs" integer NOT NULL DEFAULT '5000', "isActive" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "metadata" text, "lastDeliveryAttempt" TIMESTAMP, "lastDeliverySuccess" TIMESTAMP, "totalDeliveries" integer NOT NULL DEFAULT '0', "failedDeliveries" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_ae1dac9605019632e845cd4f3ab" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_f9a012d6f30c9ad8e5f5d8c6d6" ON "webhook_consumers" ("url") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_2b2d74b0fecc64757b033373ca" ON "webhook_consumers" ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_60519c0ef4651ab9ce331d47ed" ON "webhook_consumers" ("isActive") `,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "stellar_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "eventType" varchar(20) NOT NULL, "ledgerSequence" integer NOT NULL, "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL, "transactionHash" varchar(64) NOT NULL, "sourceAccount" varchar(56) NOT NULL, "payload" text NOT NULL, "deliveryStatus" varchar(20) NOT NULL DEFAULT 'pending', "deliveryAttempts" integer NOT NULL DEFAULT '0', "lastAttemptAt" TIMESTAMP WITH TIME ZONE, "deliveredAt" TIMESTAMP WITH TIME ZONE, "deliveredTo" text, "failedDeliveries" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "errorMessage" text, "isProcessed" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_efc7a4a026a14f41246b55d7873" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_56e937f62e6766e06118ae9b6c" ON "stellar_events" ("eventType") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_b6f5c1c7a4a8adaed3728b05d3" ON "stellar_events" ("ledgerSequence") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_f8d00fffa3b5110edf867481dd" ON "stellar_events" ("timestamp") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_9f76c9efc1e76d48e01f8eebe9" ON "stellar_events" ("transactionHash") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_3297c60e536613d9a6984b5466" ON "stellar_events" ("sourceAccount") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_842c30a1d102e48a388b3de116" ON "stellar_events" ("deliveryStatus") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_f33cdaaaeb7d011cd9167d45de" ON "stellar_events" ("lastAttemptAt") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ff0223ec6b4d2088d80a275370" ON "stellar_events" ("isProcessed") `,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "voice_jobs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" "public"."job_type_enum" NOT NULL, "status" "public"."job_status_enum" NOT NULL DEFAULT 'pending', "userId" varchar, "audioUrl" varchar, "audioHash" varchar, "transcribedText" text, "generatedAudioUrl" varchar, "inputText" text, "errorMessage" text, "retryCount" integer NOT NULL DEFAULT '0', "maxRetries" integer NOT NULL DEFAULT '3', "metadata" jsonb, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "completedAt" TIMESTAMP, CONSTRAINT "PK_voice_jobs_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_voice_jobs_status_createdAt" ON "voice_jobs" ("status", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_voice_jobs_userId_createdAt" ON "voice_jobs" ("userId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "voice_sessions" ("id" uuid NOT NULL, "userId" varchar NOT NULL, "walletAddress" varchar, "context" "public"."feature_context_enum" NOT NULL, "state" "public"."conversation_state_enum" NOT NULL, "messages" json NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lastActivityAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lastPingAt" TIMESTAMP WITH TIME ZONE, "ttl" integer NOT NULL, "socketId" varchar, "metadata" json, CONSTRAINT "PK_voice_sessions_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_voice_sessions_userId" ON "voice_sessions" ("userId")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "ai_usage_quota" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" varchar NOT NULL, "month" varchar NOT NULL, "requestCount" integer NOT NULL DEFAULT '0', "tokenCount" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_ai_usage_quota_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_ai_usage_quota_user_month" ON "ai_usage_quota" ("userId", "month")`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "audit_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "action_type" varchar NOT NULL, "actor_id" varchar NOT NULL, "entity_id" varchar, "metadata" jsonb, "timestamp" TIMESTAMP NOT NULL DEFAULT now(), "previousHash" varchar NOT NULL DEFAULT '', "hash" varchar NOT NULL DEFAULT '', "signature" varchar NOT NULL DEFAULT '', CONSTRAINT "PK_audit_logs_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_audit_logs_timestamp_id" ON "audit_logs" ("timestamp", "id")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "audit_log_archives" ("id" uuid NOT NULL, "action_type" varchar NOT NULL, "actor_id" varchar NOT NULL, "entity_id" varchar, "metadata" jsonb, "timestamp" TIMESTAMP NOT NULL, "previousHash" varchar NOT NULL DEFAULT '', "hash" varchar NOT NULL DEFAULT '', "signature" varchar NOT NULL DEFAULT '', "archivedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_audit_log_archives_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_audit_log_archives_timestamp_id" ON "audit_log_archives" ("timestamp", "id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_usage_quota"`);
    await queryRunner.query(
      `DROP UNIQUE INDEX IF EXISTS "IDX_ai_usage_quota_user_month"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "voice_sessions"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_voice_sessions_userId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "voice_jobs"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_voice_jobs_status_createdAt"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_voice_jobs_userId_createdAt"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."conversation_state_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."feature_context_enum"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."job_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."job_type_enum"`);

    await queryRunner.query(`DROP TABLE IF EXISTS "api_tokens"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_api_tokens_userId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "refresh_tokens"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_refresh_tokens_userId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "login_nonces"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "wallet_bindings"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_wallet_bindings_userId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
  }
}
