import { test } from "node:test";
import { assertThrows } from "../test/assert.ts";
import { parseExtensionManifest } from "./extension-manifest.ts";
import { StaticExtensionPolicy } from "./extension-policy.ts";

const manifest = parseExtensionManifest({
  schemaVersion: 2,
  id: "telephony.fritzbox",
  displayName: "FRITZ!Box",
  description: "Accesses a locally configured telephone system.",
  publisher: "FLAMOX365",
  version: "1.0.0",
  runtime: { kind: "node-process", entrypoint: "extension.ts" },
  capabilities: ["telephony.call.start"],
  permissions: { network: ["fritz.box:49443"], secrets: ["FRITZBOX_PASSWORD"] },
  actions: [{ name: "dial", idempotent: false, timeoutSeconds: 15 }],
});

const grant = {
  capabilities: ["telephony.call.start"],
  network: ["fritz.box:49443"],
  secrets: ["FRITZBOX_PASSWORD"],
};

test("StaticExtensionPolicy requires exact grants and a local allow rule", () => {
  const policy = new StaticExtensionPolicy([
    {
      extensionId: manifest.id,
      publishers: [manifest.publisher],
      capabilities: [...manifest.capabilities],
      network: [...manifest.permissions.network],
      secrets: [...manifest.permissions.secrets],
    },
  ]);

  policy.authorize(manifest, grant);
  assertThrows(
    () => policy.authorize(manifest, { ...grant, network: [] }),
    Error,
    "exactly match",
  );
  assertThrows(
    () => StaticExtensionPolicy.denyAll().authorize(manifest, grant),
    Error,
    "does not authorize extension",
  );
});
