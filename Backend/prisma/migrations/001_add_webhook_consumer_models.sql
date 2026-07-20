-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'RETRYING', 'DISABLED');

-- CreateTable
CREATE TABLE "webhook_consumers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "max_retries" INTEGER NOT NULL DEFAULT 3,
    "retry_delay_ms" INTEGER NOT NULL DEFAULT 5000,
    "timeout" INTEGER NOT NULL DEFAULT 30000,
    "event_types" TEXT[],
    "contract_ids" TEXT[],
    "description" TEXT,
    "tags" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_healthy" TIMESTAMP(3),

    CONSTRAINT "webhook_consumers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_event_deliveries" (
    "id" TEXT NOT NULL,
    "consumer_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "event_data" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "response_status" INTEGER,
    "response_time_ms" INTEGER,
    "response_body" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "webhook_event_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_consumers_active_idx" ON "webhook_consumers"("active");

-- CreateIndex
CREATE INDEX "webhook_consumers_event_types_idx" ON "webhook_consumers"("event_types");

-- CreateIndex
CREATE INDEX "webhook_consumers_contract_ids_idx" ON "webhook_consumers"("contract_ids");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_event_deliveries_event_id_consumer_id_key" ON "webhook_event_deliveries"("event_id", "consumer_id");

-- CreateIndex
CREATE INDEX "webhook_event_deliveries_consumer_id_status_idx" ON "webhook_event_deliveries"("consumer_id", "status");

-- CreateIndex
CREATE INDEX "webhook_event_deliveries_consumer_id_created_at_idx" ON "webhook_event_deliveries"("consumer_id", "created_at");

-- CreateIndex
CREATE INDEX "webhook_event_deliveries_event_id_idx" ON "webhook_event_deliveries"("event_id");

-- CreateIndex
CREATE INDEX "webhook_event_deliveries_status_attempts_idx" ON "webhook_event_deliveries"("status", "attempts");

-- CreateIndex
CREATE INDEX "webhook_event_deliveries_last_attempt_at_idx" ON "webhook_event_deliveries"("last_attempt_at");

-- AddForeignKey
ALTER TABLE "webhook_event_deliveries" ADD CONSTRAINT "webhook_event_deliveries_consumer_id_fkey" FOREIGN KEY ("consumer_id") REFERENCES "webhook_consumers"("id") ON DELETE CASCADE ON UPDATE CASCADE;