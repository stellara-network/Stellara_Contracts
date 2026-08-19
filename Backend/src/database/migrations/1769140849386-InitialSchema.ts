import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1769140849386 implements MigrationInterface {
  name = 'InitialSchema1769140849386';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."workflows_type_enum" AS ENUM('contract_deployment', 'trade_execution', 'ai_job_chain', 'indexing_verification', 'portfolio_update', 'reward_grant')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."workflows_state_enum" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled', 'compensating', 'compensated')`,
    );
    await queryRunner.query(
      `CREATE TABLE "workflows" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "idempotencyKey" character varying NOT NULL, "type" "public"."workflows_type_enum" NOT NULL, "state" "public"."workflows_state_enum" NOT NULL DEFAULT 'pending', "userId" character varying, "walletAddress" character varying, "input" jsonb NOT NULL, "output" jsonb, "context" jsonb, "currentStepIndex" integer NOT NULL DEFAULT '0', "totalSteps" integer NOT NULL DEFAULT '0', "startedAt" TIMESTAMP, "completedAt" TIMESTAMP, "failedAt" TIMESTAMP, "failureReason" character varying, "retryCount" integer NOT NULL DEFAULT '0', "maxRetries" integer NOT NULL DEFAULT '3', "nextRetryAt" TIMESTAMP, "requiresCompensation" boolean NOT NULL DEFAULT false, "isCompensated" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_619a202a61b92e73f20de8d29ed" UNIQUE ("idempotencyKey"), CONSTRAINT "PK_5b5757cc1cd86268019fef52e0c" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_e6b7312458454123287286afa6" ON "workflows" ("userId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_15206576633d3e612da44c882d" ON "workflows" ("type") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_98afa5ee1ac04e690c908bbf85" ON "workflows" ("state") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_619a202a61b92e73f20de8d29e" ON "workflows" ("idempotencyKey") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."workflow_steps_state_enum" AS ENUM('pending', 'running', 'completed', 'failed', 'skipped', 'compensating', 'compensated')`,
    );
    await queryRunner.query(
      `CREATE TABLE "workflow_steps" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "workflowId" uuid NOT NULL, "stepName" character varying NOT NULL, "stepIndex" integer NOT NULL, "state" "public"."workflow_steps_state_enum" NOT NULL DEFAULT 'pending', "input" jsonb, "output" jsonb, "config" jsonb, "retryCount" integer NOT NULL DEFAULT '0', "maxRetries" integer NOT NULL DEFAULT '3', "startedAt" TIMESTAMP, "completedAt" TIMESTAMP, "failedAt" TIMESTAMP, "failureReason" character varying, "nextRetryAt" TIMESTAMP, "requiresCompensation" boolean NOT NULL DEFAULT false, "isCompensated" boolean NOT NULL DEFAULT false, "compensatedAt" TIMESTAMP, "compensationStepName" character varying, "compensationConfig" jsonb, "isIdempotent" boolean NOT NULL DEFAULT false, "idempotencyKey" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b602e5ecb22943db11c96a7f31c" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5a56ecdb592cc9ed1924cd56eb" ON "workflow_steps" ("state") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_eb0c057661503827a7cd6d8ea4" ON "workflow_steps" ("workflowId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "workflow_steps" ADD CONSTRAINT "FK_eb0c057661503827a7cd6d8ea41" FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying, "username" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "isActive" boolean NOT NULL DEFAULT true, CONSTRAINT "UQ_6e888cec1c7071d77b28b507f71" UNIQUE ("email"), CONSTRAINT "PK_a3b3c2b5e9c6b5e9c6b5e9c6b5e" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "wallet_bindings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "publicKey" character varying NOT NULL, "userId" character varying NOT NULL, "boundAt" TIMESTAMP NOT NULL DEFAULT now(), "isPrimary" boolean NOT NULL DEFAULT true, "lastUsed" TIMESTAMP, CONSTRAINT "UQ_7a6b5c5d6e5f5a5b5c5d5e5f5a5b5c5d5e5f" UNIQUE ("publicKey"), CONSTRAINT "PK_5a5b5c5d5e5f5a5b5c5d5e5f5a5b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "login_nonces" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "nonce" character varying NOT NULL, "publicKey" character varying NOT NULL, "expiresAt" TIMESTAMP NOT NULL, "used" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_5a5b5c5d5e5f5a5b5c5d5e5f5a5b5c" UNIQUE ("nonce"), CONSTRAINT "PK_5a5b5c5d5e5f5a5b5c5d5e5f5a5" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "refresh_tokens" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "token" character varying NOT NULL, "userId" character varying NOT NULL, "expiresAt" TIMESTAMP NOT NULL, "revoked" boolean NOT NULL DEFAULT false, "revokedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_5a5b5c5d5e5f5a5b5c5d5e5f5a5b5" UNIQUE ("token"), CONSTRAINT "PK_5a5b5c5d5e5f5a5b5c5d5e5f5a6" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "api_tokens" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "token" character varying NOT NULL, "name" character varying NOT NULL, "role" character varying NOT NULL, "userId" character varying NOT NULL, "expiresAt" TIMESTAMP, "revoked" boolean NOT NULL DEFAULT false, "lastUsedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_5a5b5c5d5e5f5a5b5c5d5e5f5a5b6" UNIQUE ("token"), CONSTRAINT "PK_5a5b5c5d5e5f5a5b5c5d5e5f5a7" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "audit_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "action_type" character varying NOT NULL, "actor_id" character varying NOT NULL, "entity_id" character varying, "metadata" jsonb, "timestamp" TIMESTAMP NOT NULL DEFAULT now(), "previousHash" character varying NOT NULL DEFAULT '', "hash" character varying NOT NULL DEFAULT '', "signature" character varying NOT NULL DEFAULT '', CONSTRAINT "PK_audit_logs_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_timestamp_id" ON "audit_logs" ("timestamp", "id")`,
    );
    await queryRunner.query(
      `CREATE TABLE "audit_log_archives" ("id" uuid NOT NULL, "action_type" character varying NOT NULL, "actor_id" character varying NOT NULL, "entity_id" character varying, "metadata" jsonb, "timestamp" TIMESTAMP NOT NULL, "previousHash" character varying NOT NULL DEFAULT '', "hash" character varying NOT NULL DEFAULT '', "signature" character varying NOT NULL DEFAULT '', "archivedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_audit_log_archives_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_log_archives_timestamp_id" ON "audit_log_archives" ("timestamp", "id")`,
    );
    await queryRunner.query(
      `CREATE TABLE "voice_jobs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" character varying(5) NOT NULL, "status" character varying(10) NOT NULL DEFAULT 'pending', "userId" character varying, "audioUrl" character varying, "audioHash" character varying, "transcribedText" text, "generatedAudioUrl" character varying, "inputText" text, "errorMessage" text, "retryCount" integer NOT NULL DEFAULT '0', "maxRetries" integer NOT NULL DEFAULT '3', "metadata" jsonb, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "completedAt" TIMESTAMP, CONSTRAINT "PK_voice_jobs_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_voice_jobs_status_createdAt" ON "voice_jobs" ("status", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_voice_jobs_userId_createdAt" ON "voice_jobs" ("userId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE TABLE "voice_sessions" ("id" character varying(255) NOT NULL, "userId" character varying NOT NULL, "walletAddress" character varying, "context" character varying NOT NULL, "state" character varying NOT NULL, "messages" json NOT NULL, "createdAt" TIMESTAMP NOT NULL, "lastActivityAt" TIMESTAMP NOT NULL, "lastPingAt" TIMESTAMP, "ttl" integer NOT NULL, "socketId" character varying, "metadata" json, CONSTRAINT "PK_voice_sessions_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_voice_sessions_userId" ON "voice_sessions" ("userId")`,
    );
    await queryRunner.query(
      `CREATE TABLE "ai_usage_quota" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" character varying NOT NULL, "month" character varying NOT NULL, "requestCount" integer NOT NULL DEFAULT '0', "tokenCount" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_ai_usage_quota_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_ai_usage_quota_userId_month" ON "ai_usage_quota" ("userId", "month")`,
    );
    await queryRunner.query(
      `CREATE TABLE "webhook_consumers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(100) NOT NULL, "url" character varying(500) NOT NULL, "secret" character varying(100), "status" character varying(20) NOT NULL DEFAULT 'active', "maxRetries" integer NOT NULL DEFAULT '5', "timeoutMs" integer NOT NULL DEFAULT '5000', "isActive" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "metadata" text, "lastDeliveryAttempt" TIMESTAMP, "lastDeliverySuccess" TIMESTAMP, "totalDeliveries" integer NOT NULL DEFAULT '0', "failedDeliveries" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_ae1dac9605019632e845cd4f3ab" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f9a012d6f30c9ad8e5f5d8c6d6" ON "webhook_consumers" ("url") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2b2d74b0fecc64757b033373ca" ON "webhook_consumers" ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_60519c0ef4651ab9ce331d47ed" ON "webhook_consumers" ("isActive") `,
    );
    await queryRunner.query(
      `CREATE TABLE "stellar_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "eventType" character varying(20) NOT NULL, "ledgerSequence" integer NOT NULL, "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL, "transactionHash" character varying(64) NOT NULL, "sourceAccount" character varying(56) NOT NULL, "payload" text NOT NULL, "deliveryStatus" character varying(20) NOT NULL DEFAULT 'pending', "deliveryAttempts" integer NOT NULL DEFAULT '0', "lastAttemptAt" TIMESTAMP WITH TIME ZONE, "deliveredAt" TIMESTAMP WITH TIME ZONE, "deliveredTo" text, "failedDeliveries" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "errorMessage" text, "isProcessed" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_efc7a4a026a14f41246b55d7873" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_56e937f62e6766e06118ae9b6c" ON "stellar_events" ("eventType") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b6f5c1c7a4a8adaed3728b05d3" ON "stellar_events" ("ledgerSequence") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f8d00fffa3b5110edf867481dd" ON "stellar_events" ("timestamp") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_9f76c9efc1e76d48e01f8eebe9" ON "stellar_events" ("transactionHash") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3297c60e536613d9a6984b5466" ON "stellar_events" ("sourceAccount") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_842c30a1d102e48a388b3de116" ON "stellar_events" ("deliveryStatus") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f33cdaaaeb7d011cd9167d45de" ON "stellar_events" ("lastAttemptAt") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ff0223ec6b4d2088d80a275370" ON "stellar_events" ("isProcessed") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ff0223ec6b4d2088d80a275370"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f33cdaaaeb7d011cd9167d45de"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_842c30a1d102e48a388b3de116"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_3297c60e536613d9a6984b5466"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_9f76c9efc1e76d48e01f8eebe9"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f8d00fffa3b5110edf867481dd"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_b6f5c1c7a4a8adaed3728b05d3"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_56e937f62e6766e06118ae9b6c"`,
    );
    await queryRunner.query(`DROP TABLE "stellar_events"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f9a012d6f30c9ad8e5f5d8c6d6"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_2b2d74b0fecc64757b033373ca"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_60519c0ef4651ab9ce331d47ed"`,
    );
    await queryRunner.query(`DROP TABLE "webhook_consumers"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ai_usage_quota_userId_month"`,
    );
    await queryRunner.query(`DROP TABLE "ai_usage_quota"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_voice_sessions_userId"`);
    await queryRunner.query(`DROP TABLE "voice_sessions"`);
    await queryRunner.query(`DROP INDEX "IDX_voice_jobs_userId_createdAt"`);
    await queryRunner.query(`DROP INDEX "IDX_voice_jobs_status_createdAt"`);
    await queryRunner.query(`DROP TABLE "voice_jobs"`);
    await queryRunner.query(`DROP INDEX "IDX_audit_logs_timestamp_id"`);
    await queryRunner.query(`DROP TABLE "audit_logs"`);
    await queryRunner.query(`DROP INDEX "IDX_audit_log_archives_timestamp_id"`);
    await queryRunner.query(`DROP TABLE "audit_log_archives"`);
    await queryRunner.query(`DROP TABLE "api_tokens"`);
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    await queryRunner.query(`DROP TABLE "login_nonces"`);
    await queryRunner.query(`DROP TABLE "wallet_bindings"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(
      `ALTER TABLE "workflow_steps" DROP CONSTRAINT "FK_eb0c057661503827a7cd6d8ea41"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_eb0c057661503827a7cd6d8ea4"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_5a56ecdb592cc9ed1924cd56eb"`,
    );
    await queryRunner.query(`DROP TYPE "public"."workflow_steps_state_enum"`);
    await queryRunner.query(`DROP TABLE "workflow_steps"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_619a202a61b92e73f20de8d29e"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_98afa5ee1ac04e690c908bbf85"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_15206576633d3e612da44c882d"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_e6b7312458454123287286afa6"`,
    );
    await queryRunner.query(`DROP TABLE "workflows"`);
    await queryRunner.query(`DROP TYPE "public"."workflows_state_enum"`);
    await queryRunner.query(`DROP TYPE "public"."workflows_type_enum"`);
  }
}
