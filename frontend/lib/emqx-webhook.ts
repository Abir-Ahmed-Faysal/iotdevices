export type EmqxRelayState = {
  relayIndex: number;
  state: "on" | "off";
};

export type EmqxStateMessage = {
  deviceId: string;
  online: boolean;
  state?: "on" | "off";
  uptime?: number;
  requestId?: string;
  relays?: EmqxRelayState[];
};

const STATE_TOPIC_PATTERN = /^faysal-iot\/v1\/devices\/([A-Za-z0-9_-]{1,64})\/state$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseEmqxStateWebhook(body: unknown): EmqxStateMessage | null {
  if (!isRecord(body) || typeof body.topic !== "string") return null;
  const topicMatch = STATE_TOPIC_PATTERN.exec(body.topic);
  if (!topicMatch) return null;

  let payload: unknown = body.payload;
  if (typeof payload === "string") {
    if (payload.length > 8192) return null;
    try {
      payload = JSON.parse(payload) as unknown;
    } catch {
      return null;
    }
  }
  if (!isRecord(payload) || payload.deviceId !== topicMatch[1]) return null;
  if (typeof payload.online !== "boolean") return null;
  if (payload.online && payload.state !== "on" && payload.state !== "off") return null;
  if (
    payload.state !== undefined &&
    payload.state !== "on" &&
    payload.state !== "off"
  ) {
    return null;
  }
  if (
    payload.uptime !== undefined &&
    (!Number.isSafeInteger(payload.uptime) || Number(payload.uptime) < 0)
  ) {
    return null;
  }
  if (
    payload.requestId !== undefined &&
    (typeof payload.requestId !== "string" || payload.requestId.length > 64)
  ) {
    return null;
  }

  let relays: EmqxRelayState[] | undefined;
  if (payload.relays !== undefined) {
    if (!Array.isArray(payload.relays) || payload.relays.length > 4) return null;
    const seen = new Set<number>();
    relays = [];
    for (const item of payload.relays) {
      if (!isRecord(item)) return null;
      const { relayIndex, state } = item;
      if (
        !Number.isSafeInteger(relayIndex) ||
        Number(relayIndex) < 1 ||
        Number(relayIndex) > 4 ||
        (state !== "on" && state !== "off") ||
        seen.has(Number(relayIndex))
      ) {
        return null;
      }
      seen.add(Number(relayIndex));
      relays.push({ relayIndex: Number(relayIndex), state });
    }
  }

  return {
    deviceId: topicMatch[1],
    online: payload.online,
    ...(payload.state === "on" || payload.state === "off" ? { state: payload.state } : {}),
    ...(typeof payload.uptime === "number" ? { uptime: payload.uptime } : {}),
    ...(typeof payload.requestId === "string" ? { requestId: payload.requestId } : {}),
    ...(relays ? { relays } : {}),
  };
}
