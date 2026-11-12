CREATE TABLE "oauth_authorization_codes" (
    "code_hash" CHAR(64) NOT NULL,
    "username" VARCHAR(128) NOT NULL,
    "client_id" VARCHAR(255) NOT NULL,
    "redirect_uri" VARCHAR(2048) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_authorization_codes_pkey" PRIMARY KEY ("code_hash")
);

CREATE INDEX "oauth_authorization_codes_expires_at_idx"
    ON "oauth_authorization_codes"("expires_at");

CREATE TABLE "oauth_grants" (
    "id" UUID NOT NULL,
    "username" VARCHAR(128) NOT NULL,
    "client_id" VARCHAR(255) NOT NULL,
    "refresh_token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "oauth_grants_refresh_token_hash_key"
    ON "oauth_grants"("refresh_token_hash");
CREATE INDEX "oauth_grants_username_client_id_idx"
    ON "oauth_grants"("username", "client_id");
CREATE INDEX "oauth_grants_expires_at_idx"
    ON "oauth_grants"("expires_at");
