CREATE TABLE "api_rate_limits" (
    "bucket_key" CHAR(64) NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "request_count" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "api_rate_limits_pkey" PRIMARY KEY ("bucket_key")
);

CREATE INDEX "api_rate_limits_expires_at_idx"
    ON "api_rate_limits"("expires_at");
