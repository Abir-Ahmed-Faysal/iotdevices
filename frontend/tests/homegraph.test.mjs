import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import {
  reportHomeGraphState,
  requestHomeGraphSync,
} from "../lib/homegraph.ts";

test("reports relay state and requests sync using a signed service-account assertion", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const previous = process.env.GOOGLE_HOME_SERVICE_ACCOUNT_JSON;
  process.env.GOOGLE_HOME_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: "homegraph-test@example.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    token_uri: "https://oauth2.googleapis.com/token",
  });
  const requests = [];
  const fetcher = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(init.body);
      const assertion = form.get("assertion");
      const [header, claims, signature] = assertion.split(".");
      assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).alg, "RS256");
      assert.equal(
        verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url")),
        true,
      );
      return Response.json({ access_token: "mock-access-token" });
    }
    return Response.json({});
  };

  try {
    await reportHomeGraphState("user-uuid", {
      deviceId: "controller",
      name: "Controller",
      online: true,
      relays: [
        { relayIndex: 1, name: "Relay 1", state: "on" },
        { relayIndex: 2, name: "Relay 2", state: "off" },
        { relayIndex: 3, name: "Relay 3", state: "unknown" },
      ],
    }, fetcher);
    await requestHomeGraphSync("user-uuid", fetcher);
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_HOME_SERVICE_ACCOUNT_JSON;
    else process.env.GOOGLE_HOME_SERVICE_ACCOUNT_JSON = previous;
  }

  const homeGraphCalls = requests.filter((request) =>
    request.url.startsWith("https://homegraph.googleapis.com/"),
  );
  assert.equal(homeGraphCalls.length, 2);
  const report = JSON.parse(homeGraphCalls[0].init.body);
  assert.deepEqual(report.payload.devices.states, {
    controller: { online: true, on: true },
    "controller:relay2": { online: true, on: false },
    "controller:relay3": { online: true },
  });
  assert.deepEqual(JSON.parse(homeGraphCalls[1].init.body), {
    agentUserId: "user-uuid",
    async: true,
  });
});
