import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "../../../../lib/auth";
import { recordDeviceObservation } from "../../../../lib/activity";
import { DeviceOperationError, getDeviceStatus } from "../../../../lib/mqtt-device";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function GET(request: NextRequest) {
  if (!authenticate(request)) {
    return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  }
  try {
    const status = await getDeviceStatus();
    let activityWarning: string | undefined;
    try {
      await recordDeviceObservation(status);
    } catch (error) {
      console.error("Could not record device activity:", error);
      activityWarning = "Device status is available, but its activity could not be saved.";
    }
    return NextResponse.json({ ...status, activityWarning });
  } catch (error) {
    if (error instanceof DeviceOperationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Device status request failed:", error);
    return NextResponse.json({ error: "Could not retrieve device status." }, { status: 500 });
  }
}
