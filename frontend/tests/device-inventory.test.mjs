import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGoogleSyncDevices,
  resolveGoogleExecutionTargets,
  resolveGoogleTarget,
} from "../lib/google-device-mapping.ts";
import { ownedDeviceFilter } from "../lib/device-ownership.ts";

function controller(deviceId, relayCount) {
  return {
    deviceId,
    name: `${deviceId} controller`,
    relays: Array.from({ length: relayCount }, (_, index) => ({
      relayIndex: index + 1,
      name: `Relay ${index + 1}`,
      state: "off",
    })),
  };
}

test("SYNC maps one relay to the legacy device ID", () => {
  const devices = buildGoogleSyncDevices([controller("legacy-device", 1)]);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, "legacy-device");
  assert.deepEqual(devices[0].traits, ["action.devices.traits.OnOff"]);
  assert.equal(
    resolveGoogleTarget([controller("legacy-device", 1)], "legacy-device").relay.relayIndex,
    1,
  );
});

test("SYNC maps three relays to stable relay-specific IDs", () => {
  const inventory = [controller("multi-device", 3)];
  const devices = buildGoogleSyncDevices(inventory);
  assert.deepEqual(devices.map((device) => device.id), [
    "multi-device:relay1",
    "multi-device:relay2",
    "multi-device:relay3",
  ]);
  assert.deepEqual(
    devices.map((device) => resolveGoogleTarget(inventory, device.id)?.relay.relayIndex),
    [1, 2, 3],
  );
});

test("EXECUTE rejects foreign and unknown device IDs identically", () => {
  assert.deepEqual(ownedDeviceFilter("alice-user"), {
    home: { members: { some: { userId: "alice-user" } } },
  });
  const aliceInventory = [controller("alice-device", 1)];
  const foreignDevice = controller("bob-device", 1);
  assert.deepEqual(
    resolveGoogleExecutionTargets(aliceInventory, [foreignDevice.deviceId]),
    { errorCode: "deviceNotFound" },
  );
  assert.deepEqual(
    resolveGoogleExecutionTargets(aliceInventory, ["unknown-device"]),
    { errorCode: "deviceNotFound" },
  );
});
