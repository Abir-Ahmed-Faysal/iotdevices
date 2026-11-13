import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { recordDeviceObservation } from "../../../../../lib/activity";
import { parseEmqxStateWebhook } from "../../../../../lib/emqx-webhook";
import { reportHomeGraphState } from "../../../../../lib/homegraph";
import { prisma } from "../../../../../lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const MAX_BODY_BYTES = 8192;

type JsonBodyResult =
  | { body: unknown }
  | { error: "invalid" | "too_large" };

function isAuthorized(request: NextRequest) {
  const expected = process.env.EMQX_WEBHOOK_SECRET;
  const supplied = request.headers.get("x-emqx-webhook-secret");
  if (!expected || Buffer.byteLength(expected, "utf8") < 32 || !supplied) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes);
}

async function readJsonBody(request: NextRequest): Promise<JsonBodyResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      return { error: "invalid" };
    }
    if (parsedLength > MAX_BODY_BYTES) return { error: "too_large" };
  }
  if (!request.body) return { error: "invalid" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      await reader.cancel();
      return { error: "too_large" };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { body: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { error: "invalid" };
  }
}

export async function POST(request: NextRequest) {
  if (
    !process.env.EMQX_WEBHOOK_SECRET ||
    Buffer.byteLength(process.env.EMQX_WEBHOOK_SECRET, "utf8") < 32
  ) {
    return NextResponse.json({ error: "Webhook authentication is not configured." }, { status: 503 });
  }
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized webhook request." }, { status: 401 });
  }

  let message;
  try {
    const body = await readJsonBody(request);
    if ("error" in body) {
      return NextResponse.json(
        { error: body.error === "too_large" ? "Webhook request body is too large." : "Invalid webhook body." },
        { status: body.error === "too_large" ? 413 : 400 },
      );
    }
    message = parseEmqxStateWebhook(body.body);
  } catch (error) {
    console.error("Could not parse EMQX state webhook:", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ error: "Invalid EMQX webhook payload." }, { status: 400 });
  }
  if (!message) {
    return NextResponse.json({ error: "Invalid EMQX webhook payload." }, { status: 400 });
  }

  try {
    const device = await prisma.device.findUnique({
      where: { deviceId: message.deviceId },
      include: {
        relays: { orderBy: { relayIndex: "asc" } },
        home: {
          select: {
            ownerUserId: true,
            members: { select: { userId: true } },
          },
        },
      },
    });
    if (!device) {
      return NextResponse.json({ error: "Unknown device." }, { status: 404 });
    }

    await recordDeviceObservation({
      deviceId: device.deviceId,
      deviceUuid: device.id,
      userId: device.home.ownerUserId,
      online: message.online,
      uptime: message.uptime,
      state: message.online ? message.state : undefined,
      relays: message.online
        ? message.relays ?? (
          message.state ? [{ relayIndex: 1, state: message.state }] : undefined
        )
        : undefined,
    });

    const linkedUserIds = device.home.members.map((member) => member.userId);
    const grants = linkedUserIds.length === 0
      ? []
      : await prisma.oAuthGrant.findMany({
        where: {
          userId: { in: linkedUserIds },
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: { userId: true },
        distinct: ["userId"],
      });

    if (grants.length > 0) {
      const currentDevice = await prisma.device.findUnique({
        where: { id: device.id },
        include: { relays: { orderBy: { relayIndex: "asc" } } },
      });
      if (!currentDevice) throw new Error("Device disappeared after state update.");
      await Promise.all(grants.flatMap((grant) => grant.userId
        ? [reportHomeGraphState(grant.userId, currentDevice)]
        : []));
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("EMQX state processing failed:", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ error: "Could not process device state." }, { status: 502 });
  }
}
