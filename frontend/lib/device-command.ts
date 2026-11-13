import { randomUUID } from "node:crypto";
import {
  DeviceOperationError,
  setDeviceState,
  type DeviceStatus,
} from "./mqtt-device.ts";

async function getPrisma() {
  return (await import("./prisma")).prisma;
}

type CommandStatus = "pending" | "succeeded" | "failed";
type CommandAction = "on" | "off";

export type PersistedDeviceCommand = {
  id: string;
  action: CommandAction;
  status: CommandStatus;
  mqttRequestId: string;
  errorMessage: string | null;
  errorStatus: number | null;
  completedAt: Date | null;
};

export type DeviceCommandRepository = {
  acquire(deviceUuid: string, leaseId: string): Promise<boolean>;
  release(deviceUuid: string, leaseId: string): Promise<void>;
  find(
    deviceUuid: string,
    requestId: string,
    relayIndex: number,
  ): Promise<PersistedDeviceCommand | null>;
  create(input: {
    deviceUuid: string;
    requestId: string;
    mqttRequestId: string;
    relayIndex: number;
    action: CommandAction;
  }): Promise<PersistedDeviceCommand>;
  incrementAttempt(commandId: string): Promise<void>;
  complete(input: {
    commandId: string;
    deviceUuid: string;
    deviceId: string;
    deviceName: string;
    userId: string;
    relayIndex: number;
    action: CommandAction;
    eventType: "command" | "google_assistant";
    status: DeviceStatus;
  }): Promise<void>;
  fail(commandId: string, message: string, status: number): Promise<void>;
};

export type ExecuteDeviceCommandInput = {
  device: { id: string; deviceId: string; name: string };
  userId: string;
  relayIndex: number;
  action: CommandAction;
  requestId: string;
  eventType: "command" | "google_assistant";
};

export type DeviceCommandDependencies = {
  repository: DeviceCommandRepository;
  sendCommand: typeof setDeviceState;
};

function commandFromRow(row: {
  id: string;
  action: string;
  status: string;
  mqttRequestId: string;
  errorMessage: string | null;
  errorStatus: number | null;
  completedAt: Date | null;
}): PersistedDeviceCommand {
  if (
    (row.action !== "on" && row.action !== "off") ||
    (row.status !== "pending" && row.status !== "succeeded" && row.status !== "failed")
  ) {
    throw new Error("Stored device command has an invalid status.");
  }
  return { ...row, action: row.action, status: row.status };
}

const prismaRepository: DeviceCommandRepository = {
  async acquire(deviceUuid, leaseId) {
    const prisma = await getPrisma();
    await prisma.$executeRaw`
      INSERT INTO "device_command_locks" ("device_uuid")
      VALUES (${deviceUuid}::uuid)
      ON CONFLICT ("device_uuid") DO NOTHING
    `;
    const lease = await prisma.$queryRaw<Array<{ device_uuid: string }>>`
      UPDATE "device_command_locks"
      SET "lease_id" = ${leaseId}::uuid,
          "lease_expires_at" = NOW() + INTERVAL '12 seconds',
          "updated_at" = NOW()
      WHERE "device_uuid" = ${deviceUuid}::uuid
        AND ("lease_expires_at" IS NULL OR "lease_expires_at" <= NOW())
      RETURNING "device_uuid"
    `;
    return lease.length === 1;
  },
  async release(deviceUuid, leaseId) {
    const prisma = await getPrisma();
    await prisma.$executeRaw`
      UPDATE "device_command_locks"
      SET "lease_id" = NULL, "lease_expires_at" = NULL, "updated_at" = NOW()
      WHERE "device_uuid" = ${deviceUuid}::uuid AND "lease_id" = ${leaseId}::uuid
    `;
  },
  async find(deviceUuid, requestId, relayIndex) {
    const prisma = await getPrisma();
    const row = await prisma.deviceCommand.findUnique({
      where: {
        deviceUuid_requestId_relayIndex: { deviceUuid, requestId, relayIndex },
      },
    });
    return row ? commandFromRow(row) : null;
  },
  async create(input) {
    const prisma = await getPrisma();
    const row = await prisma.deviceCommand.create({ data: input });
    return commandFromRow(row);
  },
  async incrementAttempt(commandId) {
    const prisma = await getPrisma();
    await prisma.deviceCommand.update({
      where: { id: commandId },
      data: { attemptCount: { increment: 1 } },
    });
  },
  async complete(input) {
    const prisma = await getPrisma();
    const completedAt = new Date();
    await prisma.$transaction([
      prisma.relay.update({
        where: {
          deviceId_relayIndex: {
            deviceId: input.deviceUuid,
            relayIndex: input.relayIndex,
          },
        },
        data: { state: input.action },
      }),
      prisma.device.update({
        where: { id: input.deviceUuid },
        data: {
          online: input.status.online,
          ...(input.status.uptime === undefined || input.status.uptime === null
            ? {}
            : { uptimeSeconds: input.status.uptime }),
          ...(input.status.online ? { lastSeen: completedAt } : {}),
        },
      }),
      prisma.activityEvent.create({
        data: {
          eventType: input.eventType,
          message: input.eventType === "google_assistant"
            ? `Google Assistant turned ${input.deviceName} relay ${input.relayIndex} ${input.action.toUpperCase()}`
            : `Turn ${input.deviceName} relay ${input.relayIndex} ${input.action.toUpperCase()} command acknowledged`,
          deviceId: input.deviceId,
          deviceUuid: input.deviceUuid,
          userId: input.userId,
        },
      }),
      prisma.deviceCommand.update({
        where: { id: input.commandId },
        data: {
          status: "succeeded",
          errorMessage: null,
          errorStatus: null,
          completedAt,
        },
      }),
    ]);
  },
  async fail(commandId, message, status) {
    const prisma = await getPrisma();
    await prisma.deviceCommand.update({
      where: { id: commandId },
      data: {
        status: "failed",
        errorMessage: message,
        errorStatus: status,
        completedAt: new Date(),
      },
    });
  },
};

const defaultDependencies: DeviceCommandDependencies = {
  repository: prismaRepository,
  sendCommand: setDeviceState,
};

function replayedStatus(
  command: PersistedDeviceCommand,
  input: ExecuteDeviceCommandInput,
): DeviceStatus {
  if (command.status === "failed") {
    throw new DeviceOperationError(
      command.errorMessage || "The previous device command failed.",
      command.errorStatus || 502,
    );
  }
  if (command.status !== "succeeded") {
    throw new DeviceOperationError("The previous device command is still pending.", 409);
  }
  return {
    name: input.device.name,
    deviceId: input.device.deviceId,
    online: true,
    state: command.action,
    relayIndex: input.relayIndex,
    relayState: command.action,
    uptime: null,
    transport: "mqtt",
    lastSeen: command.completedAt?.toISOString() ?? null,
    requestId: command.mqttRequestId,
  };
}

function normalizedFailure(error: unknown) {
  return error instanceof DeviceOperationError
    ? error
    : new DeviceOperationError("Device command failed.", 502);
}

export async function executeDeviceCommand(
  input: ExecuteDeviceCommandInput,
  dependencies: DeviceCommandDependencies = defaultDependencies,
) {
  if (
    !input.requestId ||
    input.requestId.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(input.requestId)
  ) {
    throw new DeviceOperationError("Request ID must be 1 to 256 printable characters.", 400);
  }
  if (!Number.isSafeInteger(input.relayIndex) || input.relayIndex < 1 || input.relayIndex > 4) {
    throw new DeviceOperationError("Relay index must be between 1 and 4.", 400);
  }

  const leaseId = randomUUID();
  if (!await dependencies.repository.acquire(input.device.id, leaseId)) {
    throw new DeviceOperationError("Another command for this device is in progress.", 409);
  }

  try {
    let command = await dependencies.repository.find(
      input.device.id,
      input.requestId,
      input.relayIndex,
    );
    if (command && command.action !== input.action) {
      throw new DeviceOperationError("Request ID was already used for a different command.", 409);
    }
    if (command?.status === "succeeded" || command?.status === "failed") {
      return replayedStatus(command, input);
    }
    if (!command) {
      command = await dependencies.repository.create({
        deviceUuid: input.device.id,
        requestId: input.requestId,
        mqttRequestId: randomUUID(),
        relayIndex: input.relayIndex,
        action: input.action,
      });
    }

    await dependencies.repository.incrementAttempt(command.id);
    let status: DeviceStatus;
    try {
      status = await dependencies.sendCommand(
        input.action,
        input.relayIndex,
        input.device.deviceId,
        command.mqttRequestId,
      );
    } catch (error) {
      const failure = normalizedFailure(error);
      try {
        await dependencies.repository.fail(command.id, failure.message, failure.status);
      } catch (persistenceError) {
        console.error("Could not persist device command failure:", {
          name: persistenceError instanceof Error ? persistenceError.name : "UnknownError",
        });
      }
      throw failure;
    }

    try {
      await dependencies.repository.complete({
        commandId: command.id,
        deviceUuid: input.device.id,
        deviceId: input.device.deviceId,
        deviceName: input.device.name,
        userId: input.userId,
        relayIndex: input.relayIndex,
        action: input.action,
        eventType: input.eventType,
        status,
      });
    } catch (error) {
      const failure = new DeviceOperationError(
        "Device acknowledged the command, but its state could not be saved.",
        502,
      );
      try {
        await dependencies.repository.fail(command.id, failure.message, failure.status);
      } catch (persistenceError) {
        console.error("Could not persist device command completion failure:", {
          name: persistenceError instanceof Error ? persistenceError.name : "UnknownError",
        });
      }
      throw failure;
    }
    return status;
  } finally {
    try {
      await dependencies.repository.release(input.device.id, leaseId);
    } catch (error) {
      console.error("Could not release device command lease:", {
        name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}
