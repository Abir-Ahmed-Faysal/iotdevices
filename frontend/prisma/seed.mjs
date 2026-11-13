import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const allowedGpios = new Set([4, 14, 32, 33]);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be provided in the process environment.`);
  }
  return value;
}

async function seed() {
  const username = required("ADMIN_USERNAME");
  const deviceId = process.env.MQTT_DEVICE_ID?.trim() || "faysal-iot-001";
  const relayGpio = Number(process.env.RELAY1_GPIO || 4);
  if (username.length > 128) {
    throw new Error("ADMIN_USERNAME must be at most 128 characters.");
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) {
    throw new Error("MQTT_DEVICE_ID contains unsupported characters.");
  }
  if (!allowedGpios.has(relayGpio)) {
    throw new Error("RELAY1_GPIO must be one of the approved GPIO pins.");
  }

  await prisma.$transaction(async (transaction) => {
    const user = await transaction.user.upsert({
      where: { username },
      create: { username },
      update: {},
    });
    const homeName = process.env.HOME_NAME?.trim() || "FishVoice Home";
    const home = await transaction.home.upsert({
      where: { ownerUserId_name: { ownerUserId: user.id, name: homeName } },
      create: {
        name: homeName,
        timezone: process.env.HOME_TIMEZONE?.trim() || "Asia/Dhaka",
        ownerUserId: user.id,
      },
      update: {},
    });
    await transaction.homeMembership.upsert({
      where: { homeId_userId: { homeId: home.id, userId: user.id } },
      create: { homeId: home.id, userId: user.id, role: "owner" },
      update: { role: "owner" },
    });

    const previousState = await transaction.deviceActivityState.findUnique({
      where: { deviceId },
    });
    const device = await transaction.device.upsert({
      where: { deviceId },
      create: {
        deviceId,
        homeId: home.id,
        name: process.env.DEVICE_NAME?.trim() || "Faysal IoT",
        brokerCredentialRef: "env:MQTT_USERNAME",
        online: previousState?.online ?? false,
        uptimeSeconds: previousState?.uptimeSeconds,
        lastSeen: previousState?.updatedAt,
      },
      update: {},
    });
    if (device.homeId !== home.id) {
      throw new Error("The configured device is already assigned to a different home.");
    }
    await transaction.relay.upsert({
      where: { deviceId_relayIndex: { deviceId: device.id, relayIndex: 1 } },
      create: {
        deviceId: device.id,
        relayIndex: 1,
        gpio: relayGpio,
        activeLow: process.env.RELAY1_ACTIVE_LOW === "true",
        name: process.env.RELAY1_NAME?.trim() || "Relay 1",
        state: previousState?.outputState === "on" || previousState?.outputState === "off"
          ? previousState.outputState
          : "unknown",
      },
      update: {},
    });

    await transaction.activityEvent.updateMany({
      where: { userId: null },
      data: { userId: user.id },
    });
    await transaction.activityEvent.updateMany({
      where: { deviceId, deviceUuid: null },
      data: { deviceUuid: device.id },
    });
    await transaction.deviceActivityState.updateMany({
      where: { deviceId, deviceUuid: null },
      data: { deviceUuid: device.id },
    });
    await transaction.deviceRuntimeDaily.updateMany({
      where: { deviceId, deviceUuid: null },
      data: { deviceUuid: device.id },
    });
    await transaction.oAuthAuthorizationCode.updateMany({
      where: { username, userId: null },
      data: { userId: user.id },
    });
    await transaction.oAuthGrant.updateMany({
      where: { username, userId: null },
      data: { userId: user.id },
    });
  }, {
    maxWait: 10_000,
    timeout: 30_000,
  });

  console.log("Existing admin, home, device, relay, and legacy ownership references are seeded.");
}

try {
  await seed();
} catch (error) {
  const code = error && typeof error === "object" && "code" in error &&
    typeof error.code === "string"
    ? error.code
    : error instanceof Error ? error.name : "UnknownError";
  console.error(`Seed failed (${code}). Check the process environment and applied database migrations.`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
