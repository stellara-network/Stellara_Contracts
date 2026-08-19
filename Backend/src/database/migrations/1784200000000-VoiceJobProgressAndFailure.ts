import { MigrationInterface, QueryRunner } from 'typeorm';

export class VoiceJobProgressAndFailure1784200000000 implements MigrationInterface {
  name = 'VoiceJobProgressAndFailure1784200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE IF NOT EXISTS "public"."voice_job_stage_enum" AS ENUM('uploading', 'uploaded', 'queued', 'transcribing', 'transcription_completed', 'generating_tts', 'completed', 'failed')`,
    );
    await queryRunner.query(
      `ALTER TABLE "voice_jobs" ADD COLUMN IF NOT EXISTS "stage" "public"."voice_job_stage_enum" NOT NULL DEFAULT 'queued'`,
    );
    await queryRunner.query(
      `ALTER TABLE "voice_jobs" ADD COLUMN IF NOT EXISTS "progress" integer NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "voice_jobs" ADD COLUMN IF NOT EXISTS "failure" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "voice_jobs" ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP`,
    );
    await queryRunner.query(
      `ALTER TABLE "voice_jobs" ADD COLUMN IF NOT EXISTS "failedAt" TIMESTAMP`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "voice_jobs" DROP COLUMN IF EXISTS "failedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "voice_jobs" DROP COLUMN IF EXISTS "startedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "voice_jobs" DROP COLUMN IF EXISTS "failure"`,
    );
    await queryRunner.query(
      `ALTER TABLE "voice_jobs" DROP COLUMN IF EXISTS "progress"`,
    );
    await queryRunner.query(
      `ALTER TABLE "voice_jobs" DROP COLUMN IF EXISTS "stage"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."voice_job_stage_enum"`,
    );
  }
}
