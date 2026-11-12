import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "../../../../lib/auth";
import { recordDeviceObservation } from "../../../../lib/activity";
import {
  getDefaultOwnedDevice,
  getUserByUsername,
} from "../../../../lib/device-inventory";
import { prisma } from "../../../../lib/prisma";
import { DeviceOperationError, getDeviceStatus } from "../../../../lib/mqtt-device";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function GET(request: NextRequest) {
  const username = authenticate(request);
  if (!username) {
    return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  }
  try {
    const user = await getUserByUsername(username);
    if (!user) {
      return NextResponse.json({ error: "Device inventory is not provisioned." }, { status: 503 });
    }
    const device = await getDefaultOwnedDevice(
      user.id,
      request.nextUrl.searchParams.get("deviceId"),
    );
    if (!device) {
      return NextResponse.json({ error: "Device or relay was not found." }, { status: 404 });
    }

    const status = await getDeviceStatus(device.deviceId);
    let activityWarning: string | undefined;
    try {
      await recordDeviceObservation({
        ...status,
        deviceUuid: device.id,
        userId: user.id,
      });
    } catch (error) {
      console.error("Could not record device activity:", error);
      activityWarning = "Device status is available, but its activity could not be saved.";
    }

    const currentDevice = await prisma.device.findUnique({
      where: { id: device.id },
      include: { relays: { orderBy: { relayIndex: "asc" } } },
    });
    return NextResponse.json({
      ...status,
      name: device.name,
      relays: currentDevice?.relays.map((relay) => ({
        relayIndex: relay.relayIndex,
        name: relay.name,
        state: relay.state,
      })) ?? [],
      activityWarning,
    });
  } catch (error) {
    if (error instanceof DeviceOperationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Device status request failed:", error);
    return NextResponse.json({ error: "Could not retrieve device status." }, { status: 500 });
  }
}
