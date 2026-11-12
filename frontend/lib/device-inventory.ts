import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import {
  buildGoogleSyncDevices,
  resolveGoogleExecutionTargets,
  resolveGoogleTarget,
} from "./google-device-mapping";
import { ownedDeviceFilter } from "./device-ownership";

export {
  buildGoogleSyncDevices,
  resolveGoogleExecutionTargets,
  resolveGoogleTarget,
  ownedDeviceFilter,
};

export type InventoryDevice = Prisma.DeviceGetPayload<{
  include: { relays: { orderBy: { relayIndex: "asc" } } };
}>;

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export async function getUserByUsername(username: string) {
  return prisma.user.findUnique({
    where: { username },
    select: { id: true, username: true },
  });
}

export async function listOwnedDevices(userId: string): Promise<InventoryDevice[]> {
  return prisma.device.findMany({
    where: ownedDeviceFilter(userId),
    include: { relays: { orderBy: { relayIndex: "asc" } } },
    orderBy: [{ name: "asc" }, { deviceId: "asc" }],
  });
}

export async function getOwnedDevice(userId: string, deviceId: string) {
  if (!DEVICE_ID_PATTERN.test(deviceId)) return null;
  return prisma.device.findFirst({
    where: {
      deviceId,
      ...ownedDeviceFilter(userId),
    },
    include: { relays: { orderBy: { relayIndex: "asc" } } },
  });
}

export async function getDefaultOwnedDevice(userId: string, requestedDeviceId?: string | null) {
  if (requestedDeviceId !== undefined && requestedDeviceId !== null) {
    return getOwnedDevice(userId, requestedDeviceId);
  }

  const legacyDeviceId = process.env.MQTT_DEVICE_ID?.trim() || "faysal-iot-001";
  const legacyDevice = await getOwnedDevice(userId, legacyDeviceId);
  if (legacyDevice) return legacyDevice;

  const devices = await listOwnedDevices(userId);
  return devices.length === 1 ? devices[0] : null;
}
