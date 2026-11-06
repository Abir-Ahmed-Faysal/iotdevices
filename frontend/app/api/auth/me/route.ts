import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const username = authenticate(request);
  if (!username) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  return NextResponse.json({ username });
}
