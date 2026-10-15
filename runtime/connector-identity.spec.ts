import { test } from "node:test";
import { makeTempDirectory } from "./files.ts";
import * as fs from "node:fs/promises";
import { assertEquals } from "../test/assert.ts";
import {
  ConnectorIdentityStore,
  decryptConnectorSecret,
  generateConnectorKeyPair,
} from "./connector-identity.ts";

test("connector identity persists tenant binding and decrypts targeted secrets", async () => {
  const root = await makeTempDirectory();
  try {
    const keys = await generateConnectorKeyPair();
    const identity = {
      schemaVersion: 1 as const,
      connectorId: "connector_1",
      tenantId: "tenant_1",
      credentialSecret: "credential",
      ...keys,
      pairedAt: "2026-07-30T00:00:00.000Z",
    };
    const store = new ConnectorIdentityStore(`${root}/identity.json`);
    await store.save(identity);
    assertEquals((await store.load())?.tenantId, "tenant_1");

    const publicKey = await crypto.subtle.importKey(
      "jwk",
      keys.publicKey,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    const encrypted = await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      publicKey,
      new TextEncoder().encode("fritz-secret"),
    );
    let binary = "";
    for (const byte of new Uint8Array(encrypted)) {
      binary += String.fromCharCode(byte);
    }
    assertEquals(
      await decryptConnectorSecret(identity, {
        algorithm: "RSA-OAEP-256",
        ciphertext: btoa(binary),
      }),
      "fritz-secret",
    );
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
