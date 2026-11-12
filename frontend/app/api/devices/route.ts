import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "../../../lib/auth";
import {
  getDefaultOwnedDevice,
  getUserByUsername,
  listOwnedDevices,
} from "../../../lib/device-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const devices = await listOwnedDevices(user.id);
    const defaultDevice = await getDefaultOwnedDevice(user.id);
    return NextResponse.json({
      defaultDeviceId: defaultDevice?.deviceId ?? null,
      devices: devices.map((device) => ({
        deviceId: device.deviceId,
        name: device.name,
        online: device.online,
        lastSeen: device.lastSeen,
        relays: device.relays.map((relay) => ({
          relayIndex: relay.relayIndex,
          name: relay.name,
          gpio: relay.gpio,
          activeLow: relay.activeLow,
          state: relay.state,
        })),
      })),
    });
  } catch (error) {
    console.error("Could not load device inventory:", error);
    return NextResponse.json({ error: "Device inventory is unavailable." }, { status: 503 });
  }
}
