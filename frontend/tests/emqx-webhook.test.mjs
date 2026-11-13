import assert from "node:assert/strict";
import test from "node:test";
import { parseEmqxStateWebhook } from "../lib/emqx-webhook.ts";

test("parses retained multi-relay state snapshots from the expected device topic", () => {
  const message = parseEmqxStateWebhook({
    topic: "faysal-iot/v1/devices/controller_1/state",
    payload: JSON.stringify({
      deviceId: "controller_1",
      online: true,
      state: "off",
      uptime: 123,
      relays: [
        { relayIndex: 1, state: "off" },
        { relayIndex: 2, state: "on" },
      ],
    }),
  });
  assert.deepEqual(message, {
    deviceId: "controller_1",
    online: true,
    state: "off",
    uptime: 123,
    relays: [
      { relayIndex: 1, state: "off" },
      { relayIndex: 2, state: "on" },
    ],
  });
});

test("accepts the firmware retained offline will payload", () => {
  assert.deepEqual(
    parseEmqxStateWebhook({
      topic: "faysal-iot/v1/devices/controller_1/state",
      payload: { deviceId: "controller_1", online: false },
    }),
    { deviceId: "controller_1", online: false },
  );
});

test("rejects foreign topics, mismatched device IDs, and duplicate relay indices", () => {
  const payload = { deviceId: "controller_1", online: true, state: "off" };
  assert.equal(parseEmqxStateWebhook({
    topic: "other/v1/devices/controller_1/state",
    payload,
  }), null);
  assert.equal(parseEmqxStateWebhook({
    topic: "faysal-iot/v1/devices/controller_1/state",
    payload: { ...payload, deviceId: "controller_2" },
  }), null);
  assert.equal(parseEmqxStateWebhook({
    topic: "faysal-iot/v1/devices/controller_1/state",
    payload: {
      ...payload,
      relays: [
        { relayIndex: 1, state: "on" },
        { relayIndex: 1, state: "off" },
      ],
    },
  }), null);
});
