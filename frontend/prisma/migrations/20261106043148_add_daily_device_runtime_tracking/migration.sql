-- CreateTable
CREATE TABLE "device_runtime_daily" (
    "device_id" VARCHAR(64) NOT NULL,
    "day" DATE NOT NULL,
    "online_seconds" INTEGER NOT NULL DEFAULT 0,
    "relay_on_seconds" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "device_runtime_daily_pkey" PRIMARY KEY ("device_id","day")
);
