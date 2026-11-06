import { NextRequest, NextResponse } from "next/server";
import { authenticate, clearSessionCookie, isSameOrigin } from "../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Request origin is not allowed." }, { status: 403 });
  }
  if (!authenticate(request)) {
    return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  }
  const response = new NextResponse(null, { status: 204 });
  clearSessionCookie(response);
  return response;
}
