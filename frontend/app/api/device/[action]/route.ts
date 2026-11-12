import { NextRequest, NextResponse } from "next/server";
import { authenticate, isSameOrigin } from "../../../../lib/auth";
import { getDefaultOwnedDevice, getUserByUsername } from "../../../../lib/device-inventory";
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
  const username = authenticate(request);
  if (!username) {
    return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  }
  const { action } = await context.params;
  if (action !== "on" && action !== "off") {
    return NextResponse.json({ error: "Unknown device action." }, { status: 404 });
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
    const relayIndexValue = request.nextUrl.searchParams.get("relayIndex");
    const relayIndex = relayIndexValue === null ? 1 : Number(relayIndexValue);
    if (
      !device ||
      !Number.isSafeInteger(relayIndex) ||
      !device.relays.some((relay) => relay.relayIndex === relayIndex)
    ) {
      return NextResponse.json({ error: "Device or relay was not found." }, { status: 404 });
    }

    const status = await setDeviceState(action, relayIndex, device.deviceId);
    let activityWarning: string | undefined;
    try {
      await prisma.$transaction([
        prisma.relay.update({
          where: {
            deviceId_relayIndex: {
              deviceId: device.id,
              relayIndex,
            },
          },
          data: { state: action },
        }),
        prisma.device.update({
          where: { id: device.id },
          data: {
            online: status.online,
            ...(status.uptime === undefined || status.uptime === null
              ? {}
              : { uptimeSeconds: status.uptime }),
            ...(status.online ? { lastSeen: new Date() } : {}),
          },
        }),
        prisma.activityEvent.create({
          data: {
            eventType: "command",
            message: `Turn ${device.name} relay ${relayIndex} ${action.toUpperCase()} command acknowledged`,
            deviceId: status.deviceId,
            deviceUuid: device.id,
            userId: user.id,
          },
        }),
      ]);
    } catch (error) {
      console.error("Could not record device command activity:", error);
      activityWarning = "Device command succeeded, but its state or activity could not be saved.";
    }
    return NextResponse.json({
      ...status,
      name: device.name,
      relayIndex,
      activityWarning,
    });
  } catch (error) {
    if (error instanceof DeviceOperationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Device command failed:", error);
    return NextResponse.json({ error: "Could not send the device command." }, { status: 500 });
  }
}
