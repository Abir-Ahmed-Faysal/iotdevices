export type GoogleInventoryRelay = {
  relayIndex: number;
  name: string;
  state?: string;
};

export type GoogleInventoryDevice = {
  deviceId: string;
  name: string;
  relays: GoogleInventoryRelay[];
};

export function googleRelayDeviceId(device: GoogleInventoryDevice, relayIndex: number) {
  return relayIndex === 1
    ? device.deviceId
    : `${device.deviceId}:relay${relayIndex}`;
}

export function buildGoogleSyncDevices(devices: GoogleInventoryDevice[]) {
  return devices.flatMap((device) => device.relays.map((relay) => ({
    id: googleRelayDeviceId(device, relay.relayIndex),
    type: "action.devices.types.SWITCH",
    traits: ["action.devices.traits.OnOff"],
    name: {
      defaultNames: [device.name, relay.name],
      name: relay.name,
      nicknames: [relay.name],
    },
    willReportState: true,
    deviceInfo: {
      manufacturer: "Faysal IoT",
      model: "WT32-ETH01 Smart Relay Controller",
      hwVersion: "1.4",
      swVersion: "1.0.0",
    },
  })));
}

export function resolveGoogleTarget<
  TRelay extends GoogleInventoryRelay,
  TDevice extends { deviceId: string; name: string; relays: TRelay[] },
>(
  devices: TDevice[],
  targetId: string,
) {
  for (const device of devices) {
    let relayIndex = targetId === device.deviceId ? 1 : null;
    const relayPrefix = `${device.deviceId}:relay`;
    if (targetId.startsWith(relayPrefix)) {
      const suffix = targetId.slice(relayPrefix.length);
      const parsedIndex = Number(suffix);
      relayIndex = Number.isSafeInteger(parsedIndex) && String(parsedIndex) === suffix
        ? parsedIndex
        : null;
    }
    if (relayIndex === null) continue;

    const relay = device.relays.find((item) => item.relayIndex === relayIndex);
    if (relay) return { device, relay };
  }
  return null;
}

export function resolveGoogleExecutionTargets<
  TRelay extends GoogleInventoryRelay,
  TDevice extends { deviceId: string; name: string; relays: TRelay[] },
>(devices: TDevice[], targetIds: string[]) {
  if (targetIds.length === 0 || targetIds.some((targetId) => !targetId)) {
    return { errorCode: "protocolError" as const };
  }
  const targets: Array<{ device: TDevice; relay: TRelay }> = [];
  for (const targetId of targetIds) {
    const target = resolveGoogleTarget<TRelay, TDevice>(devices, targetId);
    if (!target) return { errorCode: "deviceNotFound" as const };
    targets.push(target);
  }
  return { targets };
}

export function buildGoogleQueryStates<
  TRelay extends GoogleInventoryRelay,
  TDevice extends { deviceId: string; name: string; online: boolean; relays: TRelay[] },
>(devices: TDevice[], targetIds: string[]) {
  const states: Record<string, { online: boolean; on?: boolean; errorCode?: string }> = {};
  for (const targetId of targetIds) {
    const target = targetId ? resolveGoogleTarget<TRelay, TDevice>(devices, targetId) : null;
    if (!target) {
      states[targetId || "unknown"] = { online: false, errorCode: "deviceNotFound" };
      continue;
    }

    states[targetId] = {
      online: target.device.online,
      ...(target.relay.state === "on" || target.relay.state === "off"
        ? { on: target.relay.state === "on" }
        : {}),
    };
  }
  return states;
}
