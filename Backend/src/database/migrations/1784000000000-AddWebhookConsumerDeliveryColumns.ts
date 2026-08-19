import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds delivery-tracking columns to webhook_consumers, supporting the webhook
 * delivery retry/dead-letter mechanism:
 *   - deliveryAttempts: retry count for the most recent in-flight event
 *   - lastError: last error message recorded on a failed/dead-lettered delivery
 */
export class AddWebhookConsumerDeliveryColumns1784000000000 implements MigrationInterface {
  name = 'AddWebhookConsumerDeliveryColumns1784000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "webhook_consumers" ADD COLUMN IF NOT EXISTS "deliveryAttempts" integer NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_consumers" ADD COLUMN IF NOT EXISTS "lastError" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "webhook_consumers" DROP COLUMN IF EXISTS "lastError"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_consumers" DROP COLUMN IF EXISTS "deliveryAttempts"`,
    );
  }
}
