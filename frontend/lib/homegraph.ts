import { createSign, randomUUID } from "node:crypto";

type HomeGraphRelay = {
  relayIndex: number;
  name: string;
  state: string;
};

export type HomeGraphDevice = {
  deviceId: string;
  name: string;
  online: boolean;
  relays: HomeGraphRelay[];
};

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri: "https://oauth2.googleapis.com/token";
};

let cachedAccessToken: string | null = null;
let cachedAccessTokenExpiresAt = 0;

function getServiceAccount(): ServiceAccount {
  const raw = process.env.GOOGLE_HOME_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Google Home service account is not configured.");

  let account: Partial<ServiceAccount>;
  try {
    account = JSON.parse(raw) as Partial<ServiceAccount>;
  } catch {
    throw new Error("Google Home service account configuration is invalid.");
  }
  if (
    typeof account.client_email !== "string" ||
    !account.client_email.includes("@") ||
    typeof account.private_key !== "string" ||
    !account.private_key.includes("PRIVATE KEY") ||
    account.token_uri !== "https://oauth2.googleapis.com/token"
  ) {
    throw new Error("Google Home service account configuration is invalid.");
  }
  return {
    client_email: account.client_email,
    private_key: account.private_key.replace(/\\n/g, "\n"),
    token_uri: account.token_uri,
  };
}

function base64Url(value: string) {
  return Buffer.from(value).toString("base64url");
}

async function getAccessToken(fetcher: typeof fetch) {
  if (cachedAccessToken && cachedAccessTokenExpiresAt > Date.now()) {
    return cachedAccessToken;
  }
  const account = getServiceAccount();
  const issuedAt = Math.floor(Date.now() / 1000);
  const unsignedAssertion = [
    base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64Url(JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/homegraph",
      aud: account.token_uri,
      iat: issuedAt,
      exp: issuedAt + 3600,
    })),
  ].join(".");
  const signer = createSign("RSA-SHA256");
  signer.update(unsignedAssertion);
  const assertion = `${unsignedAssertion}.${signer.sign(account.private_key, "base64url")}`;
  const response = await fetcher(account.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(3500),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Google Home token exchange failed with HTTP ${response.status}.`);
  }
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("access_token" in body) ||
    typeof body.access_token !== "string" ||
    body.access_token.length === 0
  ) {
    throw new Error("Google Home token exchange returned an invalid response.");
  }
  const expiresIn = "expires_in" in body && Number.isSafeInteger(body.expires_in)
    ? Number(body.expires_in)
    : 3600;
  cachedAccessToken = body.access_token;
  cachedAccessTokenExpiresAt = Date.now() + Math.max(30, expiresIn - 60) * 1000;
  return cachedAccessToken;
}

async function callHomeGraph(
  method: "devices:reportStateAndNotification" | "devices:requestSync",
  body: Record<string, unknown>,
  fetcher: typeof fetch,
) {
  const accessToken = await getAccessToken(fetcher);
  const response = await fetcher(`https://homegraph.googleapis.com/v1/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3500),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Google Home ${method} failed with HTTP ${response.status}.`);
  }
}

export function buildHomeGraphStates(device: HomeGraphDevice) {
  const states: Record<string, { online: boolean; on?: boolean }> = {};
  for (const relay of device.relays) {
    const googleDeviceId = relay.relayIndex === 1
      ? device.deviceId
      : `${device.deviceId}:relay${relay.relayIndex}`;
    states[googleDeviceId] = {
      online: device.online,
      ...(relay.state === "on" || relay.state === "off"
        ? { on: relay.state === "on" }
        : {}),
    };
  }
  return states;
}

export async function reportHomeGraphState(
  agentUserId: string,
  device: HomeGraphDevice,
  fetcher: typeof fetch = fetch,
) {
  await callHomeGraph("devices:reportStateAndNotification", {
    requestId: randomUUID(),
    agentUserId,
    payload: { devices: { states: buildHomeGraphStates(device) } },
  }, fetcher);
}

export async function requestHomeGraphSync(
  agentUserId: string,
  fetcher: typeof fetch = fetch,
) {
  await callHomeGraph("devices:requestSync", { agentUserId, async: true }, fetcher);
}
