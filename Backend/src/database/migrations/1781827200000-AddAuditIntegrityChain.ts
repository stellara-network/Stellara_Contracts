import { createHash, createHmac } from 'crypto';
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAuditIntegrityChain1781827200000 implements MigrationInterface {
  name = 'AddAuditIntegrityChain1781827200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "audit_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "action_type" character varying NOT NULL, "actor_id" character varying NOT NULL, "entity_id" character varying, "metadata" jsonb, "timestamp" TIMESTAMP NOT NULL DEFAULT now(), "previousHash" character varying NOT NULL DEFAULT '', "hash" character varying NOT NULL DEFAULT '', "signature" character varying NOT NULL DEFAULT '', CONSTRAINT "PK_audit_logs_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "previousHash" character varying NOT NULL DEFAULT ''`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "hash" character varying NOT NULL DEFAULT ''`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "signature" character varying NOT NULL DEFAULT ''`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_audit_logs_timestamp_id" ON "audit_logs" ("timestamp", "id")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "audit_log_archives" ("id" uuid NOT NULL, "action_type" character varying NOT NULL, "actor_id" character varying NOT NULL, "entity_id" character varying, "metadata" jsonb, "timestamp" TIMESTAMP NOT NULL, "previousHash" character varying NOT NULL DEFAULT '', "hash" character varying NOT NULL DEFAULT '', "signature" character varying NOT NULL DEFAULT '', "archivedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_audit_log_archives_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_audit_log_archives_timestamp_id" ON "audit_log_archives" ("timestamp", "id")`,
    );

    const rows = await queryRunner.query(
      `SELECT "id", "action_type", "actor_id", "entity_id", "metadata", "timestamp" FROM "audit_logs" ORDER BY "timestamp" ASC, "id" ASC`,
    );
    let previousHash = '';

    for (const row of rows) {
      const timestamp = new Date(row.timestamp).toISOString();
      const hash = createHash('sha256')
        .update(`${previousHash}${row.action_type}${row.actor_id}${timestamp}`)
        .digest('hex');
      const signature = createHmac('sha256', this.getHmacKey())
        .update(
          JSON.stringify({
            action_type: row.action_type,
            actor_id: row.actor_id,
            entity_id: row.entity_id ?? null,
            metadata: this.sortObject(row.metadata ?? null),
            timestamp,
            previousHash,
            hash,
          }),
        )
        .digest('hex');

      await queryRunner.query(
        `UPDATE "audit_logs" SET "previousHash" = $1, "hash" = $2, "signature" = $3 WHERE "id" = $4`,
        [previousHash, hash, signature, row.id],
      );

      previousHash = hash;
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_audit_log_archives_timestamp_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_log_archives"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_audit_logs_timestamp_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "signature"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "hash"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "previousHash"`,
    );
  }

  private getHmacKey(): string {
    return process.env.AUDIT_LOG_HMAC_KEY ?? 'change-this-audit-log-hmac-key';
  }

  private sortObject(value: any): any {
    if (Array.isArray(value)) {
      return value.map((item) => this.sortObject(item));
    }

    if (value && typeof value === 'object') {
      return Object.keys(value)
        .sort()
        .reduce((result, key) => {
          result[key] = this.sortObject(value[key]);
          return result;
        }, {});
    }

    return value;
  }
}
