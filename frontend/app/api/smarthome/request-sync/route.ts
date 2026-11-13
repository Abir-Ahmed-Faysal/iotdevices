import { NextRequest, NextResponse } from "next/server";
import { authenticate, isSameOrigin } from "../../../../lib/auth";
import { getUserByUsername } from "../../../../lib/device-inventory";
import { requestHomeGraphSync } from "../../../../lib/homegraph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Request origin is not allowed." }, { status: 403 });
  }
  const username = authenticate(request);
  if (!username) {
    return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  }

  try {
    const user = await getUserByUsername(username);
    if (!user) {
      return NextResponse.json({ error: "Device inventory is not provisioned." }, { status: 503 });
    }
    await requestHomeGraphSync(user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Google Home Request Sync failed:", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ error: "Could not request Google Home sync." }, { status: 502 });
  }
}
