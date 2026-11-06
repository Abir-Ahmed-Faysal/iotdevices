import { NextRequest, NextResponse } from "next/server";
import { createOAuthToken, getAdminUsername, verifyOAuthCode, verifyOAuthToken } from "../../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: Record<string, string> = {};
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await request.formData();
    formData.forEach((value, key) => {
      body[key] = value.toString();
    });
  } else if (contentType.includes("application/json")) {
    body = (await request.json().catch(() => ({}))) as Record<string, string>;
  } else {
    const formData = await request.formData().catch(() => null);
    if (formData) {
      formData.forEach((value, key) => {
        body[key] = value.toString();
      });
    }
  }

  const grantType = body.grant_type || request.nextUrl.searchParams.get("grant_type");

  if (grantType === "authorization_code") {
    const code = body.code || request.nextUrl.searchParams.get("code") || "";
    const verified = verifyOAuthCode(code);
    if (!verified) {
      return NextResponse.json({ error: "invalid_grant", error_description: "Invalid or expired authorization code." }, { status: 400 });
    }

    const username = getAdminUsername();
    const accessToken = createOAuthToken(username, "access");
    const refreshToken = createOAuthToken(username, "refresh");

    return NextResponse.json({
      token_type: "Bearer",
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 365 * 24 * 60 * 60,
    });
  }

  if (grantType === "refresh_token") {
    const refreshToken = body.refresh_token || request.nextUrl.searchParams.get("refresh_token") || "";
    const verified = verifyOAuthToken(refreshToken);
    if (!verified || verified.type !== "refresh") {
      return NextResponse.json({ error: "invalid_grant", error_description: "Invalid or expired refresh token." }, { status: 400 });
    }

    const username = getAdminUsername();
    const accessToken = createOAuthToken(username, "access");

    return NextResponse.json({
      token_type: "Bearer",
      access_token: accessToken,
      expires_in: 365 * 24 * 60 * 60,
    });
  }

  return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
}
