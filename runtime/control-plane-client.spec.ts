import { assertEquals, assertRejects } from "@std/assert";
import type { ConnectorIdentity } from "./connector-identity.ts";
import { ControlPlaneClient } from "./control-plane-client.ts";

Deno.test("ControlPlaneClient pairs without credentials and authenticates later requests", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/edge/connectors/pair")) {
      return Promise.resolve(Response.json({
        connectorId: "019b3ea9-7770-7000-8000-000000000001",
        tenantId: "42",
        credentialSecret: "a-connector-secret-with-sufficient-length",
      }));
    }
    return Promise.resolve(Response.json({
      schemaVersion: 1,
      revision: 0,
      publisherTrust: { schemaVersion: 1, publishers: [] },
      extensionPolicy: { schemaVersion: 1, extensions: [] },
      extensions: [],
    }));
  };
  const publicKey = { kty: "RSA", alg: "RSA-OAEP-256", n: "n", e: "AQAB" };
  const pairingClient = new ControlPlaneClient(
    "https://api.example.test/api/v1/",
    undefined,
    fetcher,
  );

  const pairing = await pairingClient.pair("edge_pairing-code", "DMZ 1", {
    publicKey,
    privateKey: { ...publicKey, d: "private" },
  });
  const identity = {
    schemaVersion: 1,
    ...pairing,
    publicKey,
    privateKey: { ...publicKey, d: "private" },
    pairedAt: "2026-07-30T12:00:00.000Z",
  } as ConnectorIdentity;
  const client = new ControlPlaneClient(
    "https://api.example.test/api/v1/",
    identity,
    fetcher,
  );
  await client.getDesiredState(0);

  assertEquals(
    requests[0].url,
    "https://api.example.test/api/v1/edge/connectors/pair",
  );
  assertEquals(
    new Headers(requests[0].init?.headers).has("authorization"),
    false,
  );
  assertEquals(
    requests[1].url,
    "https://api.example.test/api/v1/edge/connectors/control/desired?afterRevision=0",
  );
  assertEquals(
    new Headers(requests[1].init?.headers).get("authorization"),
    `EdgeConnector ${identity.connectorId}.${identity.credentialSecret}`,
  );
});

Deno.test("ControlPlaneClient refuses artifact downloads from another origin", async () => {
  const identity = {
    connectorId: "019b3ea9-7770-7000-8000-000000000001",
    tenantId: "42",
    credentialSecret: "a-connector-secret-with-sufficient-length",
  } as ConnectorIdentity;
  const client = new ControlPlaneClient(
    "https://api.example.test/api/v1/",
    identity,
  );

  await assertRejects(
    () => client.downloadBundle("https://attacker.example/extension.fmx"),
    Error,
    "management origin",
  );
});
