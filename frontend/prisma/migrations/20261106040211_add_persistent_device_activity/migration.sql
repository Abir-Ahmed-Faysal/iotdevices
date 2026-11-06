-- CreateTable
CREATE TABLE "activity_events" (
    "id" BIGSERIAL NOT NULL,
    "event_type" VARCHAR(32) NOT NULL,
    "message" VARCHAR(240) NOT NULL,
    "device_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_activity_state" (
    "device_id" VARCHAR(64) NOT NULL,
    "online" BOOLEAN NOT NULL,
    "uptime_seconds" INTEGER,
    "output_state" VARCHAR(16),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_activity_state_pkey" PRIMARY KEY ("device_id")
);

-- CreateIndex
CREATE INDEX "activity_events_created_at_idx" ON "activity_events"("created_at" DESC);
