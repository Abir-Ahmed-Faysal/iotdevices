import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { prisma } from "./prisma";

type RateLimitCount = {
  request_count: number;
};

export async function takeRateLimit(
  request: NextRequest,
  endpoint: "login" | "oauth-token",
  limit: number,
  windowMs: number,
) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("SESSION_SECRET must be configured for rate limiting.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1000) {
    throw new Error("Rate-limit policy is invalid.");
  }

  const address = request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ||
    "unknown";
  if (address.length > 128) {
    throw new Error("Client address is invalid.");
  }

  const bucketKey = createHmac("sha256", secret)
    .update(`${endpoint}\0${address}`)
    .digest("hex");
  const now = new Date();
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const expiresAt = new Date(windowStart.getTime() + windowMs * 2);

  const count = await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      DELETE FROM "api_rate_limits" WHERE "expires_at" <= ${now}
    `;
    const rows = await transaction.$queryRaw<RateLimitCount[]>`
      INSERT INTO "api_rate_limits" ("bucket_key", "window_start", "request_count", "expires_at")
      VALUES (${bucketKey}, ${windowStart}, 1, ${expiresAt})
      ON CONFLICT ("bucket_key")
      DO UPDATE SET
        "window_start" = EXCLUDED."window_start",
        "request_count" = CASE
          WHEN "api_rate_limits"."window_start" = EXCLUDED."window_start"
            THEN "api_rate_limits"."request_count" + 1
          ELSE 1
        END,
        "expires_at" = EXCLUDED."expires_at"
      RETURNING "request_count"
    `;
    return rows[0]?.request_count;
  });

  if (count === undefined) {
    throw new Error("Rate-limit counter was not returned by the database.");
  }
  return {
    allowed: count <= limit,
    retryAfterSeconds: Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000)),
  };
}
