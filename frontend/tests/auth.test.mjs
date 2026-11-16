import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

process.env.SESSION_SECRET = "unit-test-session-secret-with-at-least-32-bytes";
process.env.GOOGLE_CLIENT_ID = "test-google-client";
process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
process.env.GOOGLE_OAUTH_REDIRECT_URIS =
  "https://oauth-redirect.googleusercontent.com/r/test-project,http://localhost:3000/oauth/callback";

const {
  authenticateOAuthClient,
  createOAuthAccessToken,
  getOAuthRedirectUris,
  isOAuthStateWithinLimit,
  isOAuthRedirectUriAllowed,
  verifyOAuthToken,
} = await import("../lib/auth.ts");

test("OAuth client authentication requires both matching credentials", () => {
  assert.equal(authenticateOAuthClient("test-google-client", "test-google-client-secret"), true);
  assert.equal(authenticateOAuthClient("", "test-google-client-secret"), false);
  assert.equal(authenticateOAuthClient("test-google-client", ""), false);
  assert.equal(authenticateOAuthClient("wrong-client", "test-google-client-secret"), false);
  assert.equal(authenticateOAuthClient("test-google-client", "wrong-secret"), false);
});

test("OAuth redirect validation allows only exact configured HTTPS or loopback URIs", () => {
  assert.equal(
    isOAuthRedirectUriAllowed("https://oauth-redirect.googleusercontent.com/r/test-project"),
    true,
  );
  assert.equal(isOAuthRedirectUriAllowed("https://oauth-redirect.googleusercontent.com/r/other"), false);
  assert.equal(isOAuthRedirectUriAllowed("http://192.168.1.5/oauth/callback"), false);
  assert.deepEqual(getOAuthRedirectUris(), [
    "https://oauth-redirect.googleusercontent.com/r/test-project",
    "http://localhost:3000/oauth/callback",
  ]);
});

test("OAuth redirect configuration rejects insecure non-loopback URIs", () => {
  const configuredUris = process.env.GOOGLE_OAUTH_REDIRECT_URIS;
  process.env.GOOGLE_OAUTH_REDIRECT_URIS = "http://example.com/callback";
  try {
    assert.throws(() => getOAuthRedirectUris(), /must use HTTPS/);
  } finally {
    process.env.GOOGLE_OAUTH_REDIRECT_URIS = configuredUris;
  }
});

test("OAuth state accepts provider values over 512 bytes but rejects oversized values", () => {
  assert.equal(isOAuthStateWithinLimit("s".repeat(513)), true);
  assert.equal(isOAuthStateWithinLimit("s".repeat(4096)), true);
  assert.equal(isOAuthStateWithinLimit("s".repeat(4097)), false);
  assert.equal(isOAuthStateWithinLimit("é".repeat(2049)), false);
});

test("OAuth access tokens are signed and tampering is rejected", () => {
  const token = createOAuthAccessToken("admin", "test-google-client", "grant-id");
  const verified = verifyOAuthToken(token);
  assert.equal(verified.username, "admin");
  assert.equal(verified.type, "access");
  assert.equal(verified.clientId, "test-google-client");
  assert.equal(verified.grantId, "grant-id");
  assert.ok(verified.expiresAt > Math.floor(Date.now() / 1000));

  const [payload, signature] = token.split(".");
  const tamperedPayload = Buffer.from(JSON.stringify({
    username: "attacker",
    type: "access",
    clientId: "test-google-client",
    grantId: "grant-id",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  })).toString("base64url");
  assert.notEqual(tamperedPayload, payload);
  assert.equal(verifyOAuthToken(`${tamperedPayload}.${signature}`), null);
});

test("OAuth refresh tokens cannot be used as fulfillment access tokens", () => {
  const payload = Buffer.from(JSON.stringify({
    username: "admin",
    type: "refresh",
    clientId: "test-google-client",
    grantId: "grant-id",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  })).toString("base64url");
  const signature = createHmac("sha256", process.env.SESSION_SECRET)
    .update(payload)
    .digest("base64url");

  assert.equal(verifyOAuthToken(`${payload}.${signature}`), null);
});
