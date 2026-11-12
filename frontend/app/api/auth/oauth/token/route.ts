import { NextRequest, NextResponse } from "next/server";
import {
  authenticateOAuthClient,
  exchangeOAuthCode,
  rotateOAuthRefreshToken,
} from "../../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getClientCredentials(request: NextRequest, body: Record<string, string>) {
  const authorization = request.headers.get("authorization") || "";
  if (authorization) {
    const match = authorization.match(/^Basic\s+([A-Za-z0-9+/]+={0,2})$/i);
    if (!match) return { clientId: "", clientSecret: "" };

    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator > 0) {
      try {
        return {
          clientId: decodeURIComponent(decoded.slice(0, separator).replace(/\+/g, " ")),
          clientSecret: decodeURIComponent(decoded.slice(separator + 1).replace(/\+/g, " ")),
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
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 8192) {
    return NextResponse.json({ error: "OAuth request body is too large." }, { status: 413 });
  }

  let body: Record<string, string> = {};
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    body = (await request.json().catch(() => ({}))) as Record<string, string>;
  } else {
    const rawText = await request.text().catch(() => "");
    if (rawText) {
      const params = new URLSearchParams(rawText);
      params.forEach((value, key) => {
        body[key] = value;
      });
    }
  }

  const grantType = body.grant_type;
  const credentials = getClientCredentials(request, body);
  let clientAuthenticated: boolean;
  try {
    clientAuthenticated = authenticateOAuthClient(credentials.clientId, credentials.clientSecret);
  } catch (error) {
    console.error("OAuth token endpoint configuration is unavailable:", error);
    return NextResponse.json({ error: "OAuth token service is temporarily unavailable." }, { status: 503 });
  }
  if (!clientAuthenticated) {
    return NextResponse.json(
      { error: "invalid_client", error_description: "Invalid OAuth client credentials." },
      {
        status: 401,
        headers: {
          "Cache-Control": "no-store",
          Pragma: "no-cache",
          "WWW-Authenticate": 'Basic realm="OAuth token endpoint"',
        },
      },
    );
  }

  try {
    if (grantType === "authorization_code") {
      const code = body.code || "";
      const redirectUri = body.redirect_uri || "";
      if (!code || !redirectUri) {
        return NextResponse.json(
          { error: "invalid_grant", error_description: "Invalid or expired authorization code." },
          { status: 400 },
        );
      }

      const grant = await exchangeOAuthCode(code, credentials.clientId, redirectUri);
      if (!grant) {
        return NextResponse.json(
          { error: "invalid_grant", error_description: "Invalid or expired authorization code." },
          { status: 400 },
        );
      }

      return NextResponse.json({
        token_type: "Bearer",
        access_token: grant.accessToken,
        refresh_token: grant.refreshToken,
        expires_in: grant.expiresIn,
      }, {
        headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
      });
    }

    if (grantType === "refresh_token") {
      const refreshToken = body.refresh_token || "";
      const grant = refreshToken
        ? await rotateOAuthRefreshToken(refreshToken, credentials.clientId)
        : null;
      if (!grant) {
        return NextResponse.json(
          { error: "invalid_grant", error_description: "Invalid or expired refresh token." },
          { status: 400 },
        );
      }

      return NextResponse.json({
        token_type: "Bearer",
        access_token: grant.accessToken,
        refresh_token: grant.refreshToken,
        expires_in: grant.expiresIn,
      }, {
        headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
      });
    }
  } catch (error) {
    console.error("OAuth token exchange failed:", error);
    return NextResponse.json({ error: "OAuth token service is temporarily unavailable." }, { status: 503 });
  }

  return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
}
