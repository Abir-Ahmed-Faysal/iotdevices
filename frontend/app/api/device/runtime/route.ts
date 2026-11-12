import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "../../../../lib/auth";
import {
  getDefaultOwnedDevice,
  getUserByUsername,
  listOwnedDevices,
} from "../../../../lib/device-inventory";
import { prisma } from "../../../../lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dhakaCalendarDate(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value),
  };
}

export async function GET(request: NextRequest) {
  const username = authenticate(request);
  if (!username) {
    return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  }

  const { year, month, day } = dhakaCalendarDate(new Date());
  const currentMonthStart = Date.UTC(year, month - 1, 1);
  const previousMonthStart = Date.UTC(year, month - 2, 1);
  const nextMonthStart = Date.UTC(year, month, 1);
  try {
    const user = await getUserByUsername(username);
    if (!user) {
      return NextResponse.json({ error: "Device inventory is not provisioned." }, { status: 503 });
    }
    const requestedDeviceId = request.nextUrl.searchParams.get("deviceId");
    let devices;
    if (requestedDeviceId === null) {
      devices = await listOwnedDevices(user.id);
    } else {
      const device = await getDefaultOwnedDevice(user.id, requestedDeviceId);
      if (!device) {
        return NextResponse.json({ error: "Device or relay was not found." }, { status: 404 });
      }
      devices = [device];
    }
    const rows = await prisma.deviceRuntimeDaily.findMany({
      where: {
        deviceUuid: { in: devices.map((device) => device.id) },
        day: {
          gte: new Date(previousMonthStart),
          lt: new Date(nextMonthStart),
        },
      },
      orderBy: { day: "asc" },
      select: {
        day: true,
        onlineSeconds: true,
        relayOnSeconds: true,
      },
    });

    const toMonth = (start: number, end: number, throughDay: number) => ({
      key: new Date(start).toISOString().slice(0, 7),
      label: new Intl.DateTimeFormat("en", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(start)),
      daysInMonth: new Date(Date.UTC(
        new Date(start).getUTCFullYear(),
        new Date(start).getUTCMonth() + 1,
        0,
      )).getUTCDate(),
      throughDay,
      days: rows
        .filter((row) => row.day.getTime() >= start && row.day.getTime() < end)
        .map((row) => ({
          day: row.day.getUTCDate(),
          onlineSeconds: row.onlineSeconds,
          relayOnSeconds: row.relayOnSeconds,
        })),
    });

    return NextResponse.json({
      months: [
        toMonth(
          previousMonthStart,
          currentMonthStart,
          new Date(currentMonthStart - 1).getUTCDate(),
        ),
        toMonth(currentMonthStart, nextMonthStart, day),
      ],
      tracking: "Runtime is counted only between successful dashboard status checks no more than 30 seconds apart.",
    });
  } catch (error) {
    console.error("Could not load device runtime totals:", error);
    return NextResponse.json(
      { error: "Device runtime totals are unavailable. Check the database connection and migration." },
      { status: 503 },
    );
  }
}
