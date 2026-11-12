CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

CREATE TABLE "homes" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Dhaka',
    "owner_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "homes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "homes_owner_user_id_fkey" FOREIGN KEY ("owner_user_id")
        REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "homes_owner_user_id_name_key" ON "homes"("owner_user_id", "name");
CREATE INDEX "homes_owner_user_id_idx" ON "homes"("owner_user_id");

CREATE TABLE "home_memberships" (
    "home_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" VARCHAR(24) NOT NULL DEFAULT 'owner',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "home_memberships_pkey" PRIMARY KEY ("home_id", "user_id"),
    CONSTRAINT "home_memberships_home_id_fkey" FOREIGN KEY ("home_id")
        REFERENCES "homes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "home_memberships_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "home_memberships_user_id_idx" ON "home_memberships"("user_id");

CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "device_id" VARCHAR(64) NOT NULL,
    "home_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "broker_credential_ref" VARCHAR(255),
    "online" BOOLEAN NOT NULL DEFAULT false,
    "uptime_seconds" INTEGER,
    "last_seen" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "devices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "devices_home_id_fkey" FOREIGN KEY ("home_id")
        REFERENCES "homes"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "devices_device_id_key" ON "devices"("device_id");
CREATE INDEX "devices_home_id_device_id_idx" ON "devices"("home_id", "device_id");

CREATE TABLE "relays" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "relay_index" INTEGER NOT NULL,
    "gpio" INTEGER NOT NULL,
    "active_low" BOOLEAN NOT NULL DEFAULT false,
    "name" VARCHAR(120) NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'unknown',
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "relays_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "relays_device_id_fkey" FOREIGN KEY ("device_id")
        REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "relays_relay_index_check" CHECK ("relay_index" BETWEEN 1 AND 4),
    CONSTRAINT "relays_gpio_allowlist_check" CHECK ("gpio" IN (4, 14, 32, 33))
);
CREATE UNIQUE INDEX "relays_device_id_relay_index_key" ON "relays"("device_id", "relay_index");
CREATE UNIQUE INDEX "relays_device_id_gpio_key" ON "relays"("device_id", "gpio");

ALTER TABLE "activity_events"
    ADD COLUMN "user_id" UUID,
    ADD COLUMN "device_uuid" UUID,
    ADD CONSTRAINT "activity_events_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "activity_events_device_uuid_fkey" FOREIGN KEY ("device_uuid")
        REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "activity_events_user_id_created_at_idx" ON "activity_events"("user_id", "created_at" DESC);
CREATE INDEX "activity_events_device_uuid_created_at_idx" ON "activity_events"("device_uuid", "created_at" DESC);

ALTER TABLE "device_activity_state"
    ADD COLUMN "device_uuid" UUID,
    ADD CONSTRAINT "device_activity_state_device_uuid_fkey" FOREIGN KEY ("device_uuid")
        REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "device_activity_state_device_uuid_idx" ON "device_activity_state"("device_uuid");

ALTER TABLE "device_runtime_daily"
    ADD COLUMN "device_uuid" UUID,
    ADD CONSTRAINT "device_runtime_daily_device_uuid_fkey" FOREIGN KEY ("device_uuid")
        REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "device_runtime_daily_device_uuid_day_idx" ON "device_runtime_daily"("device_uuid", "day");

ALTER TABLE "oauth_authorization_codes"
    ADD COLUMN "user_id" UUID,
    ADD CONSTRAINT "oauth_authorization_codes_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "oauth_authorization_codes_user_id_idx" ON "oauth_authorization_codes"("user_id");

ALTER TABLE "oauth_grants"
    ADD COLUMN "user_id" UUID,
    ADD CONSTRAINT "oauth_grants_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "oauth_grants_user_id_client_id_idx" ON "oauth_grants"("user_id", "client_id");
