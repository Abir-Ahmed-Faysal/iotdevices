import mqtt, { type MqttClient } from "mqtt";
import { randomUUID } from "node:crypto";

export type DeviceStatus = {
  name?: string;
  deviceId: string;
  state?: "on" | "off" | "unknown";
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

async function requestLocalDevice(path: string) {
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

function getMqttConfig() {
  const host = process.env.MQTT_HOST?.trim();
  const username = process.env.MQTT_USERNAME?.trim();
  const password = process.env.MQTT_PASSWORD;
  const deviceId = process.env.MQTT_DEVICE_ID?.trim() || "faysal-iot-001";
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

function openClient() {
  const config = getMqttConfig();
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

function parseStatus(payload: Buffer, deviceId: string): DeviceStatus | null {
  if (payload.length > 1024) return null;
  try {
    const value = JSON.parse(payload.toString("utf8")) as Partial<DeviceStatus>;
    if (
      value.deviceId !== deviceId ||
      typeof value.online !== "boolean" ||
      (value.online && value.state !== "on" && value.state !== "off")
    ) {
      return null;
    }
    return {
      ...value,
      deviceId,
      online: value.online,
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

export async function getDeviceStatus() {
  if (getControlMode() === "local") {
    return requestLocalDevice("/status");
  }
  const { client, config } = openClient();
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
        const status = parseStatus(payload, config.deviceId);
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

export async function setDeviceState(action: "on" | "off") {
  if (getControlMode() === "local") {
    return requestLocalDevice(`/${action}`);
  }
  const { client, config } = openClient();
  try {
    await connect(client);
    return await new Promise<DeviceStatus>((resolve, reject) => {
      const requestId = randomUUID();
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
        const status = parseStatus(payload, config.deviceId);
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
          JSON.stringify({ requestId, action }),
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
