import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

export const SESSION_COOKIE = "faysal_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const OAUTH_CODE_TTL_SECONDS = 10 * 60;
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required in the Vercel project environment.`);
  }
  return value;
}

function sessionSecret() {
  const secret = required("SESSION_SECRET");
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("SESSION_SECRET must be at least 32 bytes.");
  }
  return secret;
}

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function equalStrings(left: string, right: string) {
  return timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest(),
  );
}

export function getAdminUsername() {
  return required("ADMIN_USERNAME");
}

export function getOAuthClientId() {
  return required("GOOGLE_CLIENT_ID");
}

export function getOAuthClientSecret() {
  return required("GOOGLE_CLIENT_SECRET");
}

export function getOAuthRedirectUris() {
  const redirectUris = required("GOOGLE_OAUTH_REDIRECT_URIS")
    .split(",")
    .map((redirectUri) => redirectUri.trim())
    .filter(Boolean);

  if (redirectUris.length === 0) {
    throw new Error("GOOGLE_OAUTH_REDIRECT_URIS must contain at least one URI.");
  }

  for (const redirectUri of redirectUris) {
    let parsed: URL;
    try {
      parsed = new URL(redirectUri);
    } catch {
      throw new Error("GOOGLE_OAUTH_REDIRECT_URIS contains an invalid URI.");
    }

    const isLoopbackHttp = parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
    if (
      (parsed.protocol !== "https:" && !isLoopbackHttp) ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      throw new Error("OAuth redirect URIs must use HTTPS (HTTP is allowed only for loopback).");
    }
  }

  return redirectUris;
}

export function isOAuthRedirectUriAllowed(redirectUri: string) {
  return getOAuthRedirectUris().includes(redirectUri);
}

export function authenticateOAuthClient(clientId: string, clientSecret: string) {
  if (!clientId || !clientSecret) return false;
  return equalStrings(clientId, getOAuthClientId()) &&
    equalStrings(clientSecret, getOAuthClientSecret());
}

export function authenticate(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;

  const secret = sessionSecret();
  const username = getAdminUsername();
  try {
    const payload = token.slice(0, separator);
    const suppliedSignature = token.slice(separator + 1);
    const expectedSignature = signature(payload, secret);
    if (!equalStrings(suppliedSignature, expectedSignature)) return null;

    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      username?: unknown;
      expiresAt?: unknown;
    };
    if (
      session.username !== username ||
      typeof session.expiresAt !== "number" ||
      session.expiresAt <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return session.username;
  } catch {
    return null;
  }
}

export function setSessionCookie(response: NextResponse, username: string) {
  const payload = Buffer.from(JSON.stringify({
    username,
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  })).toString("base64url");
  const token = `${payload}.${signature(payload, sessionSecret())}`;
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 0,
    path: "/",
  });
}

export function isSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === request.nextUrl.host;
  } catch {
    return false;
  }
}

export function constantTimeStringEqual(left: string, right: string) {
  return equalStrings(left, right);
}

function hashOpaqueToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createOAuthCode(username: string, clientId: string, redirectUri: string) {
  const code = randomBytes(32).toString("base64url");
  const now = new Date();
  const { prisma } = await import("./prisma");
  await prisma.$transaction(async (transaction) => {
    const user = await transaction.user.findUnique({
      where: { username },
      select: { id: true },
    });
    if (!user) {
      throw new Error("The authenticated account has not been provisioned in the device inventory.");
    }
    await transaction.oAuthAuthorizationCode.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    await transaction.oAuthAuthorizationCode.create({
      data: {
        codeHash: hashOpaqueToken(code),
        username,
        userId: user.id,
        clientId,
        redirectUri,
        expiresAt: new Date(now.getTime() + OAUTH_CODE_TTL_SECONDS * 1000),
      },
    });
  });
  return code;
}

export async function exchangeOAuthCode(code: string, clientId: string, redirectUri: string) {
  if (!code || code.length > 512 || redirectUri.length > 2048) return null;
  const { prisma } = await import("./prisma");
  return prisma.$transaction(async (transaction) => {
    const now = new Date();
    const codeHash = hashOpaqueToken(code);
    const authorization = await transaction.oAuthAuthorizationCode.findUnique({
      where: { codeHash },
    });
    if (
      !authorization ||
      !authorization.userId ||
      authorization.clientId !== clientId ||
      authorization.redirectUri !== redirectUri ||
      authorization.expiresAt <= now ||
      authorization.consumedAt !== null
    ) {
      return null;
    }

    const consumed = await transaction.oAuthAuthorizationCode.updateMany({
      where: {
        codeHash,
        clientId,
        redirectUri,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) return null;

    await transaction.oAuthGrant.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    const grantId = randomUUID();
    const refreshToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000);
    await transaction.oAuthGrant.create({
      data: {
        id: grantId,
        username: authorization.username,
        userId: authorization.userId,
        clientId,
        refreshTokenHash: hashOpaqueToken(refreshToken),
        expiresAt,
      },
    });

    return {
      accessToken: createOAuthAccessToken(authorization.username, clientId, grantId),
      refreshToken,
      expiresIn: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    };
  });
}

export function createOAuthAccessToken(username: string, clientId: string, grantId: string) {
  const payload = Buffer.from(JSON.stringify({
    username,
    type: "access",
    clientId,
    grantId,
    expiresAt: Math.floor(Date.now() / 1000) + OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  })).toString("base64url");
  return `${payload}.${signature(payload, sessionSecret())}`;
}

function createOAuthGrantTokens(username: string, clientId: string, grantId: string) {
  const refreshToken = randomBytes(32).toString("base64url");
  return {
    accessToken: createOAuthAccessToken(username, clientId, grantId),
    refreshToken,
  };
}

export async function rotateOAuthRefreshToken(refreshToken: string, clientId: string) {
  if (!refreshToken || refreshToken.length > 512) return null;
  const now = new Date();
  const oldTokenHash = hashOpaqueToken(refreshToken);
  const { prisma } = await import("./prisma");
  const grant = await prisma.oAuthGrant.findUnique({
    where: { refreshTokenHash: oldTokenHash },
  });
  if (
    !grant ||
    grant.clientId !== clientId ||
    grant.revokedAt !== null ||
    grant.expiresAt <= now
  ) {
    return null;
  }

  const tokens = createOAuthGrantTokens(grant.username, grant.clientId, grant.id);
  const rotated = await prisma.oAuthGrant.updateMany({
    where: {
      id: grant.id,
      clientId,
      refreshTokenHash: oldTokenHash,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    data: { refreshTokenHash: hashOpaqueToken(tokens.refreshToken) },
  });
  if (rotated.count !== 1) return null;

  return {
    ...tokens,
    expiresIn: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  };
}

export function verifyOAuthToken(token: string) {
  if (token.length > 4096) return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const secret = sessionSecret();
  try {
    const payload = token.slice(0, separator);
    const suppliedSignature = token.slice(separator + 1);
    const expectedSignature = signature(payload, secret);
    if (!equalStrings(suppliedSignature, expectedSignature)) return null;

    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      username?: unknown;
      type?: unknown;
      clientId?: unknown;
      grantId?: unknown;
      expiresAt?: unknown;
    };
    if (
      typeof data.username !== "string" ||
      typeof data.clientId !== "string" ||
      data.type !== "access" ||
      typeof data.grantId !== "string" ||
      typeof data.expiresAt !== "number" ||
      data.expiresAt <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return {
      username: data.username,
      type: "access" as const,
      clientId: data.clientId,
      grantId: data.grantId,
      expiresAt: data.expiresAt,
    };
  } catch {
    return null;
  }
}

export async function isOAuthGrantActive(grantId: string, username: string, clientId: string) {
  const { prisma } = await import("./prisma");
  return Boolean(await prisma.oAuthGrant.findFirst({
    where: {
      id: grantId,
      username,
      clientId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      userId: { not: null },
    },
    select: { id: true },
  }));
}

export async function revokeOAuthGrant(grantId: string, username: string, clientId: string) {
  const { prisma } = await import("./prisma");
  const result = await prisma.oAuthGrant.updateMany({
    where: {
      id: grantId,
      username,
      clientId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  return result.count === 1;
}
