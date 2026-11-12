import { NextRequest, NextResponse } from "next/server";
import {
  isOAuthGrantActive,
  revokeOAuthGrant,
  verifyOAuthToken,
} from "../../../../lib/auth";
import { getDeviceStatus, setDeviceState } from "../../../../lib/mqtt-device";
import { prisma } from "../../../../lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const MAX_FULFILLMENT_BODY_BYTES = 8192;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readFulfillmentBody(request: NextRequest) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      return { error: "Invalid Content-Length.", status: 400 } as const;
    }
    if (parsedLength > MAX_FULFILLMENT_BODY_BYTES) {
      return { error: "Fulfillment request body is too large.", status: 413 } as const;
    }
  }

  if (!request.body) {
    return { error: "Invalid Google Smart Home request payload.", status: 400 } as const;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_FULFILLMENT_BODY_BYTES) {
      await reader.cancel();
      return { error: "Fulfillment request body is too large.", status: 413 } as const;
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
    return { body: JSON.parse(new TextDecoder().decode(bytes)) as unknown } as const;
  } catch {
    return { error: "Invalid Google Smart Home request payload.", status: 400 } as const;
  }
}

function relayIndexForTarget(targetId: unknown, deviceId: string) {
  if (targetId === deviceId) return 1;
  if (typeof targetId !== "string") return null;
  const prefix = `${deviceId}:relay`;
  if (!targetId.startsWith(prefix)) return null;
  const index = Number(targetId.slice(prefix.length));
  return Number.isSafeInteger(index) && index === 1 ? index : null;
}

async function authenticateGoogleRequest(request: NextRequest) {
  const authHeader = request.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  const verified = verifyOAuthToken(token);
  if (!verified || verified.type !== "access" || !verified.grantId || !verified.clientId) {
    return null;
  }
  if (!await isOAuthGrantActive(verified.grantId, verified.username, verified.clientId)) {
    return null;
  }
  return verified;
}

export async function POST(request: NextRequest) {
  let token: Awaited<ReturnType<typeof authenticateGoogleRequest>>;
  try {
    token = await authenticateGoogleRequest(request);
  } catch (error) {
    console.error("Could not validate Google OAuth grant:", error);
    return NextResponse.json({ error: "Google Home authorization is temporarily unavailable." }, { status: 503 });
  }
  if (!token) {
    return NextResponse.json({ error: "Unauthorized access." }, { status: 401 });
  }

  let parsedBody: Awaited<ReturnType<typeof readFulfillmentBody>>;
  try {
    parsedBody = await readFulfillmentBody(request);
  } catch (error) {
    console.error("Could not read Google Smart Home request body:", error);
    return NextResponse.json({ error: "Could not read Google Smart Home request payload." }, { status: 400 });
  }
  if ("error" in parsedBody) {
    return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
  }
  const body = parsedBody.body;
  if (!isRecord(body) || !Array.isArray(body.inputs) || body.inputs.length === 0) {
    return NextResponse.json({ error: "Invalid Google Smart Home request payload." }, { status: 400 });
  }

  const requestId = body.requestId;
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 256) {
    return NextResponse.json({ error: "Invalid Google Smart Home request ID." }, { status: 400 });
  }
  const deviceId = process.env.MQTT_DEVICE_ID?.trim() || "faysal-iot-001";
  const input = body.inputs[0];
  if (!isRecord(input) || typeof input.intent !== "string") {
    return NextResponse.json({ error: "Invalid Google Smart Home intent." }, { status: 400 });
  }
  const intent = input.intent;

  if (intent === "action.devices.SYNC") {
    return NextResponse.json({
      requestId,
      payload: {
        agentUserId: token.username,
        devices: [
          {
            id: deviceId,
            type: "action.devices.types.SWITCH",
            traits: ["action.devices.traits.OnOff"],
            name: {
              defaultNames: ["Faysal IoT Relay Controller"],
              name: "Motor 1",
              nicknames: ["Motor 1", "Motor", "Main Relay", "Pump", "Switch"],
            },
            willReportState: false,
            deviceInfo: {
              manufacturer: "Faysal IoT",
              model: "WT32-ETH01 Smart Relay Controller",
              hwVersion: "1.4",
              swVersion: "1.0.0",
            },
          },
        ],
      },
    });
  }

  if (intent === "action.devices.QUERY") {
    try {
      const status = await getDeviceStatus();
      return NextResponse.json({
        requestId,
        payload: {
          devices: {
            [deviceId]: {
              online: status.online,
              on: status.state === "on",
            },
          },
        },
      });
    } catch {
      return NextResponse.json({
        requestId,
        payload: {
          devices: {
            [deviceId]: {
              online: false,
            },
          },
        },
      });
    }
  }

  if (intent === "action.devices.EXECUTE") {
    const payload = isRecord(input.payload) ? input.payload : null;
    const commands = payload?.commands;
    if (!Array.isArray(commands)) {
      return NextResponse.json({ error: "Invalid EXECUTE commands." }, { status: 400 });
    }
    const results: Array<{ ids: string[]; status: string; states?: Record<string, boolean>; errorCode?: string }> = [];

    for (const commandItem of commands) {
      if (!isRecord(commandItem)) {
        results.push({ ids: [], status: "ERROR", errorCode: "protocolError" });
        continue;
      }
      const targetDevices = commandItem.devices;
      const targetIds = Array.isArray(targetDevices)
        ? targetDevices.map((device) => isRecord(device) && typeof device.id === "string" ? device.id : "")
        : [];
      const relayIndexes = targetIds.map((targetId) => relayIndexForTarget(targetId, deviceId));
      const executions = commandItem.execution;
      if (
        targetIds.length === 0 ||
        targetIds.some((targetId) => !targetId) ||
        relayIndexes.some((relayIndex) => relayIndex === null)
      ) {
        results.push({
          ids: targetIds,
          status: "ERROR",
          errorCode: targetIds.some((targetId) => !targetId) ? "protocolError" : "deviceNotFound",
        });
        continue;
      }
      if (!Array.isArray(executions) || executions.length === 0) {
        results.push({ ids: targetIds, status: "ERROR", errorCode: "protocolError" });
        continue;
      }

      for (const exec of executions) {
        if (!isRecord(exec) || exec.command !== "action.devices.commands.OnOff") {
          results.push({ ids: targetIds, status: "ERROR", errorCode: "functionNotSupported" });
          continue;
        }
        const params = isRecord(exec.params) ? exec.params : null;
        if (typeof params?.on !== "boolean") {
          results.push({ ids: targetIds, status: "ERROR", errorCode: "protocolError" });
          continue;
        }

        const action = params.on ? "on" : "off";
        const relayIndex = relayIndexes[0];
        if (relayIndex === null || relayIndex === undefined) {
          results.push({ ids: targetIds, status: "ERROR", errorCode: "deviceNotFound" });
          continue;
        }
        try {
          const status = await setDeviceState(action, relayIndex);
          runCatching(async () => {
            await prisma.activityEvent.create({
              data: {
                eventType: "google_assistant",
                message: `Google Assistant turned ${action.toUpperCase()} Motor 1`,
                deviceId: status.deviceId,
              },
            });
          });
          results.push({
            ids: targetIds,
            status: "SUCCESS",
            states: {
              online: status.online,
              on: status.state === "on",
            },
          });
        } catch {
          results.push({
            ids: targetIds,
            status: "ERROR",
            errorCode: "deviceOffline",
          });
        }
      }
    }

    return NextResponse.json({
      requestId,
      payload: {
        commands: results,
      },
    });
  }

  if (intent === "action.devices.DISCONNECT") {
    try {
      await revokeOAuthGrant(token.grantId, token.username, token.clientId);
      return NextResponse.json({});
    } catch (error) {
      console.error("Could not revoke Google OAuth grant:", error);
      return NextResponse.json({ error: "Google Home disconnect is temporarily unavailable." }, { status: 503 });
    }
  }

  return NextResponse.json({ error: "Unsupported Smart Home intent." }, { status: 400 });
}

function runCatching(fn: () => Promise<void>) {
  fn().catch((error) => {
    console.error("Background task error:", error);
  });
}
