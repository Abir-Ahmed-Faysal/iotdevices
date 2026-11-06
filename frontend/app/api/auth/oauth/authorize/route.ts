import { NextRequest, NextResponse } from "next/server";
import { authenticate, createOAuthCode, getAdminUsername } from "../../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const clientId = searchParams.get("client_id") || "google-home-client";
  const redirectUri = searchParams.get("redirect_uri");
  const state = searchParams.get("state") || "";
  const responseType = searchParams.get("response_type");

  if (responseType !== "code") {
    return NextResponse.json({ error: "Unsupported response_type. Must be 'code'." }, { status: 400 });
  }
  if (!redirectUri) {
    return NextResponse.json({ error: "Missing redirect_uri parameter." }, { status: 400 });
  }

  const authenticatedUser = authenticate(request);
  if (!authenticatedUser) {
    const loginUrl = new URL("/", request.url);
    loginUrl.searchParams.set("redirect", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }

  const code = createOAuthCode(getAdminUsername(), clientId, redirectUri);
  const targetUrl = new URL(redirectUri);
  targetUrl.searchParams.set("code", code);
  if (state) {
    targetUrl.searchParams.set("state", state);
  }

  return NextResponse.redirect(targetUrl);
}

export async function POST(request: NextRequest) {
  return GET(request);
}
