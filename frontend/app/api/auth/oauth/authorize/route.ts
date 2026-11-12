import { NextRequest, NextResponse } from "next/server";
import {
  authenticate,
  constantTimeStringEqual,
  createOAuthCode,
  getOAuthClientId,
  isOAuthRedirectUriAllowed,
} from "../../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const clientId = searchParams.get("client_id");
  const redirectUri = searchParams.get("redirect_uri");
  const state = searchParams.get("state") || "";
  const responseType = searchParams.get("response_type");

  if (responseType !== "code") {
    return NextResponse.json({ error: "Unsupported response_type. Must be 'code'." }, { status: 400 });
  }
  if (!redirectUri || redirectUri.length > 2048) {
    return NextResponse.json({ error: "Invalid or unregistered redirect_uri." }, { status: 400 });
  }

  let redirectAllowed: boolean;
  let configuredClientId: string;
  try {
    redirectAllowed = isOAuthRedirectUriAllowed(redirectUri);
    configuredClientId = getOAuthClientId();
  } catch (error) {
    console.error("OAuth authorization configuration is unavailable:", error);
    return NextResponse.json({ error: "OAuth authorization is temporarily unavailable." }, { status: 503 });
  }
  if (!redirectAllowed) {
    return NextResponse.json({ error: "Invalid or unregistered redirect_uri." }, { status: 400 });
  }
  if (!clientId || !constantTimeStringEqual(clientId, configuredClientId)) {
    return NextResponse.json({ error: "Unknown OAuth client." }, { status: 401 });
  }
  if (state.length > 512) {
    return NextResponse.json({ error: "OAuth state is too long." }, { status: 400 });
  }

  const authenticatedUser = authenticate(request);
  if (!authenticatedUser) {
    const loginUrl = new URL("/", request.url);
    loginUrl.searchParams.set("redirect", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }

  let code: string;
  try {
    code = await createOAuthCode(authenticatedUser, clientId, redirectUri);
  } catch (error) {
    console.error("Could not create OAuth authorization code:", error);
    return NextResponse.json({ error: "OAuth authorization is temporarily unavailable." }, { status: 503 });
  }

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
