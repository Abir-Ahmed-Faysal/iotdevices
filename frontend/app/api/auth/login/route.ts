import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import {
  constantTimeStringEqual,
  getAdminUsername,
  isSameOrigin,
  setSessionCookie,
} from "../../../../lib/auth";
import { prisma } from "../../../../lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let passwordHash: Promise<string> | undefined;

function getPasswordHash() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) throw new Error("ADMIN_PASSWORD is required in the Vercel project environment.");
  if (Buffer.byteLength(password, "utf8") > 72) {
    throw new Error("ADMIN_PASSWORD must be at most 72 bytes for bcrypt.");
  }
  passwordHash ??= bcrypt.hash(password, 12);
  return passwordHash;
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Request origin is not allowed." }, { status: 403 });
  }
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 4096) {
    return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { username, password } = body as Record<string, unknown>;
  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    username.length > 128 ||
    Buffer.byteLength(password, "utf8") > 72
  ) {
    return NextResponse.json({ error: "Username or password is incorrect." }, { status: 401 });
  }

  const expectedUsername = getAdminUsername();
  const usernameMatches = constantTimeStringEqual(username, expectedUsername);
  const passwordMatches = await bcrypt.compare(password, await getPasswordHash());
  const valid = usernameMatches && passwordMatches;
  if (!valid) {
    return NextResponse.json({ error: "Username or password is incorrect." }, { status: 401 });
  }

  let activityWarning: string | undefined;
  try {
    await prisma.activityEvent.create({
      data: { eventType: "login", message: "Signed in to the dashboard" },
    });
  } catch (error) {
    console.error("Could not record dashboard sign-in:", error);
    activityWarning = "Sign-in succeeded, but activity could not be saved.";
  }

  const response = NextResponse.json({ username: expectedUsername, activityWarning });
  setSessionCookie(response, expectedUsername);
  return response;
}
