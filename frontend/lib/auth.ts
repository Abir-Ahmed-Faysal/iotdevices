import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

export const SESSION_COOKIE = "faysal_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const OAUTH_CODE_TTL_SECONDS = 10 * 60;
const OAUTH_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

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

export function authenticateOAuthClient(clientId: string, clientSecret: string) {
  return constantTimeStringEqual(clientId, getOAuthClientId()) &&
    constantTimeStringEqual(clientSecret, required("GOOGLE_CLIENT_SECRET"));
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

export function createOAuthCode(username: string, clientId: string, redirectUri: string) {
  const payload = Buffer.from(JSON.stringify({
    username,
    clientId,
    redirectUri,
    expiresAt: Math.floor(Date.now() / 1000) + OAUTH_CODE_TTL_SECONDS,
  })).toString("base64url");
  return `${payload}.${signature(payload, sessionSecret())}`;
}

export function verifyOAuthCode(code: string) {
  const separator = code.lastIndexOf(".");
  if (separator <= 0) return null;
  const secret = sessionSecret();
  try {
    const payload = code.slice(0, separator);
    const suppliedSignature = code.slice(separator + 1);
    const expectedSignature = signature(payload, secret);
    if (!equalStrings(suppliedSignature, expectedSignature)) return null;

    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      username?: string;
      clientId?: string;
      redirectUri?: string;
      expiresAt?: number;
    };
    if (!data.username || typeof data.expiresAt !== "number" || data.expiresAt <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function createOAuthToken(username: string, tokenType: "access" | "refresh", clientId: string) {
  const payload = Buffer.from(JSON.stringify({
    username,
    type: tokenType,
    clientId,
    expiresAt: Math.floor(Date.now() / 1000) + OAUTH_TOKEN_TTL_SECONDS,
  })).toString("base64url");
  return `${payload}.${signature(payload, sessionSecret())}`;
}

export function verifyOAuthToken(token: string) {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const secret = sessionSecret();
  try {
    const payload = token.slice(0, separator);
    const suppliedSignature = token.slice(separator + 1);
    const expectedSignature = signature(payload, secret);
    if (!equalStrings(suppliedSignature, expectedSignature)) return null;

    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      username?: string;
      type?: string;
      clientId?: string;
      expiresAt?: number;
    };
    if (
      !data.username ||
      typeof data.expiresAt !== "number" ||
      data.expiresAt <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
