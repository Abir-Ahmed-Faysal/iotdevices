import { NextRequest, NextResponse } from "next/server";
import { authenticate, isSameOrigin } from "../../../../lib/auth";
import { prisma } from "../../../../lib/prisma";
import { DeviceOperationError, setDeviceState } from "../../../../lib/mqtt-device";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ action: string }> },
) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Request origin is not allowed." }, { status: 403 });
  }
  if (!authenticate(request)) {
    return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  }
  const { action } = await context.params;
  if (action !== "on" && action !== "off") {
    return NextResponse.json({ error: "Unknown device action." }, { status: 404 });
  }
  try {
    const status = await setDeviceState(action);
    let activityWarning: string | undefined;
    try {
      await prisma.activityEvent.create({
        data: {
          eventType: "command",
          message: `Turn ${action.toUpperCase()} command acknowledged`,
          deviceId: status.deviceId,
        },
      });
    } catch (error) {
      console.error("Could not record device command activity:", error);
      activityWarning = "Device command succeeded, but its activity could not be saved.";
    }
    return NextResponse.json({ ...status, activityWarning });
  } catch (error) {
    if (error instanceof DeviceOperationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Device command failed:", error);
    return NextResponse.json({ error: "Could not send the device command." }, { status: 500 });
  }
}
