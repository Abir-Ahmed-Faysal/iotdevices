import assert from "node:assert/strict";
import test from "node:test";
import { DeviceOperationError } from "../lib/mqtt-device.ts";
import { executeDeviceCommand } from "../lib/device-command.ts";

class MemoryCommandRepository {
  commands = new Map();
  locked = false;

  async acquire() {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  async release() {
    this.locked = false;
  }

  key(deviceUuid, requestId, relayIndex) {
    return `${deviceUuid}:${requestId}:${relayIndex}`;
  }

  async find(deviceUuid, requestId, relayIndex) {
    return this.commands.get(this.key(deviceUuid, requestId, relayIndex)) ?? null;
  }

  async create(input) {
    const command = {
      ...input,
      id: `${input.deviceUuid}:${input.requestId}:${input.relayIndex}`,
      status: "pending",
      errorMessage: null,
      errorStatus: null,
      completedAt: null,
    };
    this.commands.set(this.key(input.deviceUuid, input.requestId, input.relayIndex), command);
    return command;
  }

  async incrementAttempt() {}

  async complete({ commandId, status }) {
    const command = [...this.commands.values()].find((item) => item.id === commandId);
    command.status = "succeeded";
    command.completedAt = new Date();
    command.result = status;
  }

  async fail(commandId, message, status) {
    const command = [...this.commands.values()].find((item) => item.id === commandId);
    command.status = "failed";
    command.errorMessage = message;
    command.errorStatus = status;
    command.completedAt = new Date();
  }
}

const commandInput = {
  device: { id: "device-uuid", deviceId: "controller", name: "Controller" },
  userId: "user-uuid",
  relayIndex: 2,
  action: "on",
  requestId: "google-request-123",
  eventType: "google_assistant",
};

test("waits for MQTT acknowledgment once and replays successful requests idempotently", async () => {
  const repository = new MemoryCommandRepository();
  const mqttCalls = [];
  const dependencies = {
    repository,
    async sendCommand(...args) {
      mqttCalls.push(args);
      return {
        deviceId: "controller",
        online: true,
        state: "on",
        relayIndex: 2,
        relayState: "on",
        requestId: args[3],
        transport: "mqtt",
        lastSeen: new Date().toISOString(),
      };
    },
  };

  const first = await executeDeviceCommand(commandInput, dependencies);
  const replay = await executeDeviceCommand(commandInput, dependencies);
  assert.equal(first.state, "on");
  assert.equal(replay.state, "on");
  assert.equal(mqttCalls.length, 1);
  assert.equal(mqttCalls[0][3], first.requestId);
  await assert.rejects(
    executeDeviceCommand({ ...commandInput, action: "off" }, dependencies),
    (error) => error instanceof DeviceOperationError && error.status === 409,
  );
  assert.equal(mqttCalls.length, 1);
});

test("rejects overlapping commands for the same device", async () => {
  const repository = new MemoryCommandRepository();
  let releaseDispatch;
  let dispatchStarted;
  const started = new Promise((resolve) => { dispatchStarted = resolve; });
  const dependencies = {
    repository,
    async sendCommand(action, relayIndex, deviceId, requestId) {
      dispatchStarted();
      await new Promise((resolve) => { releaseDispatch = resolve; });
      return {
        deviceId,
        online: true,
        state: action,
        relayIndex,
        relayState: action,
        requestId,
        transport: "mqtt",
        lastSeen: new Date().toISOString(),
      };
    },
  };

  const firstCommand = executeDeviceCommand(commandInput, dependencies);
  await started;
  await assert.rejects(
    executeDeviceCommand({ ...commandInput, requestId: "parallel-request" }, dependencies),
    (error) => error instanceof DeviceOperationError && error.status === 409,
  );
  releaseDispatch();
  await firstCommand;
});

test("stores failed acknowledgments and does not resend a failed request", async () => {
  const repository = new MemoryCommandRepository();
  let mqttCalls = 0;
  const dependencies = {
    repository,
    async sendCommand() {
      mqttCalls += 1;
      throw new DeviceOperationError("Device did not acknowledge the command in time.", 504);
    },
  };

  await assert.rejects(
    executeDeviceCommand(commandInput, dependencies),
    (error) => error instanceof DeviceOperationError && error.status === 504,
  );
  await assert.rejects(
    executeDeviceCommand(commandInput, dependencies),
    (error) => error instanceof DeviceOperationError && error.status === 504,
  );
  assert.equal(mqttCalls, 1);
});
