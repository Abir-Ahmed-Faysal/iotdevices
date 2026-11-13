import mqtt, { type MqttClient } from "mqtt";
import { randomUUID } from "node:crypto";

export type DeviceStatus = {
  name?: string;
  deviceId: string;
  state?: "on" | "off" | "unknown";
  relayIndex?: number;
  relayState?: "on" | "off";
  relays?: Array<{ relayIndex: number; name?: string; state: "on" | "off" }>;
  ip?: string;
  uptime?: number | null;
  online: boolean;
  transport: "mqtt";
  lastSeen: string | null;
  requestId?: string;
};

export class DeviceOperationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function getControlMode() {
  const mode = process.env.CONTROL_MODE || "mqtt";
  if (mode !== "mqtt" && mode !== "local") {
    throw new Error("CONTROL_MODE must be either local or mqtt.");
  }
  return mode;
}

async function requestLocalDevice(path: string, deviceId?: string) {
  const configuredDeviceId = process.env.MQTT_DEVICE_ID?.trim() || "faysal-iot-001";
  if (deviceId && deviceId !== configuredDeviceId) {
    throw new DeviceOperationError("Local control is configured for a different device.", 503);
  }
  const espIp = process.env.ESP_IP?.trim();
  if (!espIp) throw new Error("ESP_IP is required when CONTROL_MODE=local.");

  let response: Response;
  try {
    response = await fetch(`http://${espIp}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    throw new DeviceOperationError(
      "Could not reach the ESP32. Check its IP and WiFi connection.",
      502,
    );
  }
  if (!response.ok) {
    throw new DeviceOperationError("The ESP32 returned an error.", 502);
  }

  const body = await response.json() as Omit<DeviceStatus, "online" | "transport" | "lastSeen">;
  return {
    ...body,
    online: true,
    transport: "local" as const,
    lastSeen: new Date().toISOString(),
  };
}

function getMqttConfig(requestedDeviceId?: string) {
  const host = process.env.MQTT_HOST?.trim();
  const username = process.env.MQTT_USERNAME?.trim();
  const password = process.env.MQTT_PASSWORD;
  const deviceId = requestedDeviceId || process.env.MQTT_DEVICE_ID?.trim() || "faysal-iot-001";
  const port = Number(process.env.MQTT_PORT || 8883);
  const ca = process.env.MQTT_CA_PEM?.replace(/\\n/g, "\n").trim();

  if (!host || !username || !password || !ca) {
    throw new Error("MQTT_HOST, MQTT_USERNAME, MQTT_PASSWORD, and MQTT_CA_PEM are required.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MQTT_PORT must be a valid TCP port.");
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) {
    throw new Error("MQTT_DEVICE_ID may contain letters, numbers, underscores, and hyphens.");
  }
  if (!ca.includes("-----BEGIN CERTIFICATE-----") || !ca.includes("-----END CERTIFICATE-----")) {
    throw new Error("MQTT_CA_PEM must contain a PEM-encoded CA certificate.");
  }
  return { host, port, username, password, deviceId, ca };
}

function openClient(deviceId?: string) {
  const config = getMqttConfig(deviceId);
  const client = mqtt.connect(`mqtts://${config.host}:${config.port}`, {
    username: config.username,
    password: config.password,
    clientId: `faysal-vercel-${randomUUID()}`,
    clean: true,
    connectTimeout: 3500,
    reconnectPeriod: 0,
    keepalive: 10,
    rejectUnauthorized: true,
    ca: config.ca,
  });
  return { client, config };
}

function closeClient(client: MqttClient) {
  return new Promise<void>((resolve, reject) => {
    client.end(true, {}, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function connect(client: MqttClient) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(
      new DeviceOperationError("Cloud broker connection timed out.", 503),
    ), 4000);
    client.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    client.once("error", () => {
      clearTimeout(timer);
      reject(new DeviceOperationError("Could not connect to the cloud broker.", 503));
    });
  });
}

function parseStatus(payload: Buffer, deviceId: string, requestedRelayIndex = 1): DeviceStatus | null {
  if (payload.length > 1024) return null;
  try {
    const value = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
    if (
      value.deviceId !== deviceId ||
      typeof value.online !== "boolean" ||
      (value.online && value.state !== "on" && value.state !== "off")
    ) {
      return null;
    }
    let relays: DeviceStatus["relays"];
    if (value.relays !== undefined) {
      if (!Array.isArray(value.relays)) return null;
      relays = [];
      for (const item of value.relays) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
        const relay = item as Record<string, unknown>;
        if (
          !Number.isInteger(relay.relayIndex) ||
          Number(relay.relayIndex) < 1 ||
          Number(relay.relayIndex) > 4 ||
          (relay.state !== "on" && relay.state !== "off")
        ) {
          return null;
        }
        relays.push({
          relayIndex: Number(relay.relayIndex),
          name: typeof relay.name === "string" ? relay.name : undefined,
          state: relay.state,
        });
      }
    }
    const selectedRelay = relays?.find((relay) => relay.relayIndex === requestedRelayIndex);
    const specificRelayState = value.relayIndex === requestedRelayIndex &&
      (value.relayState === "on" || value.relayState === "off")
      ? value.relayState
      : selectedRelay?.state;
    return {
      name: typeof value.name === "string" ? value.name : undefined,
      deviceId,
      online: value.online,
      state: requestedRelayIndex === 1
        ? selectedRelay?.state ?? value.state as DeviceStatus["state"]
        : specificRelayState ?? "unknown",
      relayIndex: requestedRelayIndex,
      relayState: specificRelayState,
      relays,
      ip: typeof value.ip === "string" ? value.ip : undefined,
      uptime: typeof value.uptime === "number" ? value.uptime : null,
      requestId: typeof value.requestId === "string" ? value.requestId : undefined,
      transport: "mqtt",
      lastSeen: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function offlineStatus(deviceId: string): DeviceStatus {
  return {
    name: "Faysal IoT",
    deviceId,
    state: "unknown",
    ip: "-",
    uptime: null,
    online: false,
    transport: "mqtt",
    lastSeen: null,
  };
}

export async function getDeviceStatus(deviceId?: string, relayIndex = 1) {
  if (!Number.isSafeInteger(relayIndex) || relayIndex < 1 || relayIndex > 4) {
    throw new DeviceOperationError("Relay index must be between 1 and 4.", 400);
  }
  if (getControlMode() === "local") {
    if (relayIndex !== 1) {
      throw new DeviceOperationError("Local control supports only relay 1.", 503);
    }
    return requestLocalDevice("/status", deviceId);
  }
  const { client, config } = openClient(deviceId);
  try {
    await connect(client);
    return await new Promise<DeviceStatus>((resolve, reject) => {
      let settled = false;
      const finish = (status: DeviceStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(status);
      };
      const timer = setTimeout(() => finish(offlineStatus(config.deviceId)), 2000);

      client.on("message", (topic, payload) => {
        if (topic !== `faysal-iot/v1/devices/${config.deviceId}/state`) return;
        const status = parseStatus(payload, config.deviceId, relayIndex);
        if (status) finish(status);
      });
      client.subscribe(`faysal-iot/v1/devices/${config.deviceId}/state`, { qos: 1 }, (error) => {
        if (error) {
          clearTimeout(timer);
          settled = true;
          reject(new DeviceOperationError("Could not subscribe to device status.", 502));
        }
      });
    });
  } finally {
    await closeClient(client);
  }
}

export async function setDeviceState(
  action: "on" | "off",
  relayIndex = 1,
  deviceId?: string,
  requestedId?: string,
) {
  if (!Number.isSafeInteger(relayIndex) || relayIndex < 1 || relayIndex > 4) {
    throw new DeviceOperationError("Relay index must be between 1 and 4.", 400);
  }
  const requestId = requestedId || randomUUID();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
    throw new DeviceOperationError("Request ID must be 1 to 64 safe characters.", 400);
  }
  if (getControlMode() === "local") {
    if (relayIndex !== 1) {
      throw new DeviceOperationError("Local control supports only relay 1.", 503);
    }
    return requestLocalDevice(`/${action}`, deviceId);
  }
  const { client, config } = openClient(deviceId);
  try {
    await connect(client);
    return await new Promise<DeviceStatus>((resolve, reject) => {
      const expectedState = action;
      let settled = false;
      const finish = (error?: DeviceOperationError, status?: DeviceStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else if (status) resolve(status);
      };
      const timer = setTimeout(() => {
        finish(new DeviceOperationError("Device did not acknowledge the command in time.", 504));
      }, 4500);

      client.on("message", (topic, payload) => {
        if (topic !== `faysal-iot/v1/devices/${config.deviceId}/state`) return;
        const status = parseStatus(payload, config.deviceId, relayIndex);
        if (!status || status.requestId !== requestId) return;
        if (status.state !== expectedState) {
          finish(new DeviceOperationError("Device acknowledged an unexpected state.", 502));
          return;
        }
        finish(undefined, status);
      });

      client.subscribe(`faysal-iot/v1/devices/${config.deviceId}/state`, { qos: 1 }, (subscribeError) => {
        if (subscribeError) {
          finish(new DeviceOperationError("Could not subscribe to device acknowledgements.", 502));
          return;
        }
        client.publish(
          `faysal-iot/v1/devices/${config.deviceId}/command`,
          JSON.stringify({ requestId, action, relayIndex }),
          { qos: 1, retain: false },
          (publishError) => {
            if (publishError) {
              finish(new DeviceOperationError("Could not send the device command.", 502));
            }
          },
        );
      });
    });
  } finally {
    await closeClient(client);
  }
}
