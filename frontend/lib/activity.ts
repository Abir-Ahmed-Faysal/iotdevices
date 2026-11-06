import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

type DeviceObservation = {
  deviceId: string;
  online: boolean;
  uptime?: number | null;
  state?: "on" | "off" | "unknown";
};

const MAX_TRACKED_GAP_MS = 30_000;
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

async function addRuntimeSeconds(
  transaction: Prisma.TransactionClient,
  deviceId: string,
  startMs: number,
  endMs: number,
  relayWasOn: boolean,
) {
  let cursor = startMs;
  while (cursor < endMs) {
    const dhakaDate = new Date(cursor + DHAKA_OFFSET_MS);
    const dayStartMs = Date.UTC(
      dhakaDate.getUTCFullYear(),
      dhakaDate.getUTCMonth(),
      dhakaDate.getUTCDate(),
    );
    const segmentEnd = Math.min(endMs, dayStartMs + 86_400_000 - DHAKA_OFFSET_MS);
    const seconds = Math.floor((segmentEnd - cursor) / 1000);
    if (seconds > 0) {
      const day = new Date(dayStartMs);
      await transaction.deviceRuntimeDaily.upsert({
        where: { deviceId_day: { deviceId, day } },
        create: {
          deviceId,
          day,
          onlineSeconds: seconds,
          relayOnSeconds: relayWasOn ? seconds : 0,
        },
        update: {
          onlineSeconds: { increment: seconds },
          ...(relayWasOn ? { relayOnSeconds: { increment: seconds } } : {}),
        },
      });
    }
    cursor = segmentEnd;
  }
}

export async function recordDeviceObservation(observation: DeviceObservation) {
  await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtext(${observation.deviceId})) IS NULL AS locked
    `;

    const previous = await transaction.deviceActivityState.findUnique({
      where: { deviceId: observation.deviceId },
    });
    const uptimeSeconds = observation.uptime ?? null;
    const observedAt = new Date();
    const events: string[] = [];

    if (!previous && observation.online) {
      events.push("Device connected");
    } else if (previous?.online && !observation.online) {
      events.push("Device disconnected");
    } else if (previous && !previous.online && observation.online) {
      events.push("Device connected");
    }

    if (
      previous?.online &&
      observation.online &&
      previous.uptimeSeconds !== null &&
      previous.uptimeSeconds !== undefined &&
      uptimeSeconds !== null &&
      uptimeSeconds < previous.uptimeSeconds
    ) {
      events.push("Device restarted");
    }

    if (
      observation.online &&
      (observation.state === "on" || observation.state === "off") &&
      previous?.outputState &&
      previous.outputState !== observation.state
    ) {
      events.push(`Output changed to ${observation.state.toUpperCase()}`);
    }

    if (previous?.online && observation.online) {
      const elapsedMs = observedAt.getTime() - previous.updatedAt.getTime();
      if (elapsedMs > 0 && elapsedMs <= MAX_TRACKED_GAP_MS) {
        await addRuntimeSeconds(
          transaction,
          observation.deviceId,
          previous.updatedAt.getTime(),
          observedAt.getTime(),
          previous.outputState === "on" && observation.state === "on",
        );
      }
    }

    if (events.length) {
      await transaction.activityEvent.createMany({
        data: events.map((message) => ({
          eventType: "device",
          message,
          deviceId: observation.deviceId,
        })),
      });
    }

    await transaction.deviceActivityState.upsert({
      where: { deviceId: observation.deviceId },
      create: {
        deviceId: observation.deviceId,
        online: observation.online,
        uptimeSeconds,
        outputState: observation.state === "unknown" ? null : observation.state,
      },
      update: {
        online: observation.online,
        updatedAt: observedAt,
        ...(uptimeSeconds === null ? {} : { uptimeSeconds }),
        ...(observation.state === "unknown" ? {} : { outputState: observation.state }),
      },
    });
  });
}
