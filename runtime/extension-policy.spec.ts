import { test } from "node:test";
import { assertThrows } from "../test/assert.ts";
import { parseExtensionManifest } from "./extension-manifest.ts";
import {
  ManagedExtensionPolicy,
  StaticExtensionPolicy,
} from "./extension-policy.ts";

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

const localRule = {
  extensionId: manifest.id,
  publishers: [manifest.publisher],
  capabilities: [...manifest.capabilities],
  network: [...manifest.permissions.network],
  secrets: [...manifest.permissions.secrets],
};

test("local policy authorizes the exact grant when management is not configured", () => {
  const policy = new ManagedExtensionPolicy(
    new StaticExtensionPolicy([localRule]),
    false,
  );

  policy.authorize(manifest, grant);
  assertThrows(
    () => policy.authorize(manifest, { ...grant, network: [] }),
    Error,
    "exactly match",
  );
});

test("local policy stays deny-all without an explicit local authorization", () => {
  const policy = new ManagedExtensionPolicy(undefined, false);

  assertThrows(
    () => policy.authorize(manifest, grant),
    Error,
    "does not authorize extension",
  );
});

test("managed policy never falls back to local authorization before managed approval", () => {
  const policy = new ManagedExtensionPolicy(
    new StaticExtensionPolicy([localRule]),
  );

  assertThrows(
    () => policy.authorize(manifest, grant),
    Error,
    "does not authorize extension",
  );
  policy.updateManagedRules({ schemaVersion: 1, extensions: [localRule] });
  policy.authorize(manifest, grant);

  const locallyDenied = new ManagedExtensionPolicy(
    StaticExtensionPolicy.denyAll(),
  );
  locallyDenied.updateManagedRules({
    schemaVersion: 1,
    extensions: [localRule],
  });
  assertThrows(
    () => locallyDenied.authorize(manifest, grant),
    Error,
    "does not authorize extension",
  );
});
