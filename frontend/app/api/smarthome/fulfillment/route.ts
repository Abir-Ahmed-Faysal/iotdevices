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

  const body = await request.json().catch(() => null);
  if (!body || !body.inputs || !Array.isArray(body.inputs)) {
    return NextResponse.json({ error: "Invalid Google Smart Home request payload." }, { status: 400 });
  }

  const requestId = body.requestId || "req-1";
  const deviceId = process.env.MQTT_DEVICE_ID?.trim() || "faysal-iot-001";
  const input = body.inputs[0];
  const intent = input?.intent;

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
            willReportState: true,
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
    const commands = input.payload?.commands || [];
    const results: Array<{ ids: string[]; status: string; states?: Record<string, boolean>; errorCode?: string }> = [];

    for (const commandItem of commands) {
      const targetIds = (commandItem.devices || []).map((d: { id: string }) => d.id);
      const executions = commandItem.execution || [];

      for (const exec of executions) {
        if (exec.command === "action.devices.commands.OnOff") {
          const turnOn = Boolean(exec.params?.on);
          const action = turnOn ? "on" : "off";
          try {
            const status = await setDeviceState(action);
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
