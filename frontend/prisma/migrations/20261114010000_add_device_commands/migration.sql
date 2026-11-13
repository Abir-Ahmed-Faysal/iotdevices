CREATE TABLE "device_commands" (
    "id" UUID NOT NULL,
    "device_uuid" UUID NOT NULL,
    "request_id" VARCHAR(256) NOT NULL,
    "mqtt_request_id" UUID NOT NULL,
    "relay_index" INTEGER NOT NULL,
    "action" VARCHAR(3) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" VARCHAR(240),
    "error_status" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "device_commands_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "device_commands_device_uuid_fkey" FOREIGN KEY ("device_uuid")
        REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "device_commands_relay_index_check" CHECK ("relay_index" BETWEEN 1 AND 4),
    CONSTRAINT "device_commands_action_check" CHECK ("action" IN ('on', 'off')),
    CONSTRAINT "device_commands_status_check" CHECK ("status" IN ('pending', 'succeeded', 'failed'))
);
CREATE UNIQUE INDEX "device_commands_mqtt_request_id_key"
    ON "device_commands"("mqtt_request_id");
CREATE UNIQUE INDEX "device_commands_device_uuid_request_id_relay_index_key"
    ON "device_commands"("device_uuid", "request_id", "relay_index");
CREATE INDEX "device_commands_device_uuid_created_at_idx"
    ON "device_commands"("device_uuid", "created_at" DESC);
CREATE INDEX "device_commands_status_updated_at_idx"
    ON "device_commands"("status", "updated_at");

CREATE TABLE "device_command_locks" (
    "device_uuid" UUID NOT NULL,
    "lease_id" UUID,
    "lease_expires_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_command_locks_pkey" PRIMARY KEY ("device_uuid"),
    CONSTRAINT "device_command_locks_device_uuid_fkey" FOREIGN KEY ("device_uuid")
        REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "device_command_locks_lease_expires_at_idx"
    ON "device_command_locks"("lease_expires_at");

INSERT INTO "device_command_locks" ("device_uuid")
SELECT "id" FROM "devices";
