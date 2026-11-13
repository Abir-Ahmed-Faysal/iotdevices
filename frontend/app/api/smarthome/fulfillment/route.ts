import { NextRequest, NextResponse } from "next/server";
import {
  isOAuthGrantActive,
  revokeOAuthGrant,
  verifyOAuthToken,
} from "../../../../lib/auth";
import {
  buildGoogleQueryStates,
  buildGoogleSyncDevices,
  listOwnedDevices,
  resolveGoogleExecutionTargets,
} from "../../../../lib/device-inventory";
import { setDeviceState } from "../../../../lib/mqtt-device";
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
  const user = await prisma.user.findUnique({
    where: { username: verified.username },
    select: { id: true },
  });
  return user ? { ...verified, userId: user.id } : null;
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
  const input = body.inputs[0];
  if (!isRecord(input) || typeof input.intent !== "string") {
    return NextResponse.json({ error: "Invalid Google Smart Home intent." }, { status: 400 });
  }
  const intent = input.intent;

  if (intent === "action.devices.SYNC") {
    try {
      const devices = await listOwnedDevices(token.userId);
      return NextResponse.json({
        requestId,
        payload: {
          agentUserId: token.userId,
          devices: buildGoogleSyncDevices(devices),
        },
      });
    } catch (error) {
      console.error("Could not load Google Home device inventory:", error);
      return NextResponse.json({ error: "Google Home device inventory is unavailable." }, { status: 503 });
    }
  }

  if (intent === "action.devices.QUERY") {
    const payload = isRecord(input.payload) ? input.payload : null;
    const requestedDevices = payload?.devices;
    if (!Array.isArray(requestedDevices) || requestedDevices.length === 0) {
      return NextResponse.json({ error: "Invalid QUERY devices." }, { status: 400 });
    }
    try {
      const devices = await listOwnedDevices(token.userId);
      const targetIds = requestedDevices.map((requested) =>
        isRecord(requested) && typeof requested.id === "string" ? requested.id : "",
      );
      return NextResponse.json({
        requestId,
        payload: { devices: buildGoogleQueryStates(devices, targetIds) },
      });
    } catch (error) {
      console.error("Could not query Google Home device state:", error);
      return NextResponse.json({ error: "Google Home device state is unavailable." }, { status: 503 });
    }
  }

  if (intent === "action.devices.EXECUTE") {
    const payload = isRecord(input.payload) ? input.payload : null;
    const commands = payload?.commands;
    if (!Array.isArray(commands)) {
      return NextResponse.json({ error: "Invalid EXECUTE commands." }, { status: 400 });
    }
    const results: Array<{
      ids: string[];
      status: string;
      states?: Record<string, boolean>;
      errorCode?: string;
    }> = [];

    for (const commandItem of commands) {
      if (!isRecord(commandItem)) {
        results.push({ ids: [], status: "ERROR", errorCode: "protocolError" });
        continue;
      }
      const targetDevices = commandItem.devices;
      const targetIds = Array.isArray(targetDevices)
        ? targetDevices.map((device) => isRecord(device) && typeof device.id === "string" ? device.id : "")
        : [];
      let devices;
      try {
        devices = await listOwnedDevices(token.userId);
      } catch (error) {
        console.error("Could not load Google Home device inventory:", error);
        results.push({ ids: targetIds, status: "ERROR", errorCode: "hardError" });
        continue;
      }
      const targetResolution = resolveGoogleExecutionTargets(devices, targetIds);
      const executions = commandItem.execution;
      if ("errorCode" in targetResolution) {
        results.push({
          ids: targetIds,
          status: "ERROR",
          errorCode: targetResolution.errorCode,
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
        let failed = false;
        try {
          for (const target of targetResolution.targets) {
            const status = await setDeviceState(
              action,
              target.relay.relayIndex,
              target.device.deviceId,
            );
            try {
              await prisma.$transaction([
                prisma.relay.update({
                  where: {
                    deviceId_relayIndex: {
                      deviceId: target.device.id,
                      relayIndex: target.relay.relayIndex,
                    },
                  },
                  data: { state: action },
                }),
                prisma.device.update({
                  where: { id: target.device.id },
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
                    eventType: "google_assistant",
                    message: `Google Assistant turned ${target.relay.name} ${action.toUpperCase()}`,
                    deviceId: target.device.deviceId,
                    deviceUuid: target.device.id,
                    userId: token.userId,
                  },
                }),
              ]);
            } catch (error) {
              console.error("Could not persist Google Home device command state:", error);
              failed = true;
              break;
            }
          }
          if (failed) {
            results.push({ ids: targetIds, status: "ERROR", errorCode: "hardError" });
          } else {
            results.push({
              ids: targetIds,
              status: "SUCCESS",
              states: { online: true, on: action === "on" },
            });
          }
        } catch (error) {
          console.error("Google Home device command failed:", error);
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
