import { NextRequest, NextResponse } from "next/server";
import { authenticateOAuthClient, createOAuthToken, getAdminUsername, verifyOAuthCode, verifyOAuthToken } from "../../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getClientCredentials(request: NextRequest, body: Record<string, string>) {
  const authorization = request.headers.get("authorization") || "";
  if (authorization.startsWith("Basic ")) {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator > 0) {
      try {
        return {
          clientId: decodeURIComponent(decoded.slice(0, separator)),
          clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
        };
      } catch {
        return { clientId: "", clientSecret: "" };
      }
    }
  }
  return {
    clientId: body.client_id || "",
    clientSecret: body.client_secret || "",
  };
}

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
  const credentials = getClientCredentials(request, body);
  if (!authenticateOAuthClient(credentials.clientId, credentials.clientSecret)) {
    return NextResponse.json(
      { error: "invalid_client", error_description: "Invalid OAuth client credentials." },
      { status: 401, headers: { "WWW-Authenticate": 'Basic realm="OAuth token endpoint"' } },
    );
  }

  if (grantType === "authorization_code") {
    const code = body.code || request.nextUrl.searchParams.get("code") || "";
    const redirectUri = body.redirect_uri || request.nextUrl.searchParams.get("redirect_uri") || "";
    const verified = verifyOAuthCode(code);
    if (
      !verified ||
      verified.clientId !== credentials.clientId ||
      verified.redirectUri !== redirectUri
    ) {
      return NextResponse.json({ error: "invalid_grant", error_description: "Invalid or expired authorization code." }, { status: 400 });
    }

    const username = getAdminUsername();
    const accessToken = createOAuthToken(username, "access", credentials.clientId);
    const refreshToken = createOAuthToken(username, "refresh", credentials.clientId);

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
    if (!verified || verified.type !== "refresh" || verified.clientId !== credentials.clientId) {
      return NextResponse.json({ error: "invalid_grant", error_description: "Invalid or expired refresh token." }, { status: 400 });
    }

    const username = getAdminUsername();
    const accessToken = createOAuthToken(username, "access", credentials.clientId);

    return NextResponse.json({
      token_type: "Bearer",
      access_token: accessToken,
      expires_in: 365 * 24 * 60 * 60,
    });
  }

  return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
}
