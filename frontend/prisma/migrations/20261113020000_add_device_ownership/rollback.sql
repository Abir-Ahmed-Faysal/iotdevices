DROP INDEX "oauth_grants_user_id_client_id_idx";
ALTER TABLE "oauth_grants"
    DROP CONSTRAINT "oauth_grants_user_id_fkey",
    DROP COLUMN "user_id";

DROP INDEX "oauth_authorization_codes_user_id_idx";
ALTER TABLE "oauth_authorization_codes"
    DROP CONSTRAINT "oauth_authorization_codes_user_id_fkey",
    DROP COLUMN "user_id";

DROP INDEX "device_runtime_daily_device_uuid_day_idx";
ALTER TABLE "device_runtime_daily"
    DROP CONSTRAINT "device_runtime_daily_device_uuid_fkey",
    DROP COLUMN "device_uuid";

DROP INDEX "device_activity_state_device_uuid_idx";
ALTER TABLE "device_activity_state"
    DROP CONSTRAINT "device_activity_state_device_uuid_fkey",
    DROP COLUMN "device_uuid";

DROP INDEX "activity_events_device_uuid_created_at_idx";
DROP INDEX "activity_events_user_id_created_at_idx";
ALTER TABLE "activity_events"
    DROP CONSTRAINT "activity_events_device_uuid_fkey",
    DROP CONSTRAINT "activity_events_user_id_fkey",
    DROP COLUMN "device_uuid",
    DROP COLUMN "user_id";

DROP TABLE "relays";
DROP TABLE "devices";
DROP TABLE "home_memberships";
DROP TABLE "homes";
DROP TABLE "users";
