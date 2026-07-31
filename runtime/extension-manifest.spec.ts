import { assertEquals, assertThrows } from "@std/assert";
import { parseExtensionManifest } from "./extension-manifest.ts";

const validManifest = () => ({
  schemaVersion: 2,
  id: "system.diagnostics",
  displayName: "Connector diagnostics",
  description: "Reports a minimal connector diagnostic response.",
  publisher: "FLAMOX365",
  version: "1.0.0",
  runtime: { kind: "deno-worker", entrypoint: "extension.ts" },
  capabilities: ["system.diagnostics.read"],
  permissions: { network: [], secrets: [] },
  actions: [{ name: "status", idempotent: true, timeoutSeconds: 5 }],
  contributions: [],
  health: { action: "status", timeoutSeconds: 5 },
});

Deno.test("parseExtensionManifest returns a normalized strict manifest", () => {
  const manifest = parseExtensionManifest(validManifest());

  assertEquals(manifest.id, "system.diagnostics");
  assertEquals(manifest.runtime.entrypoint, "extension.ts");
  assertEquals(manifest.actions[0].idempotent, true);
  assertEquals(manifest.contributions, []);
});

Deno.test("parseExtensionManifest keeps Area contributions optional for generic extensions", () => {
  const generic = validManifest();
  delete (generic as { contributions?: unknown }).contributions;
  assertEquals(parseExtensionManifest(generic).contributions, []);
});

Deno.test("parseExtensionManifest validates an opted-in telephony provider contract", () => {
  const actions = [
    { name: "dial", idempotent: false, timeoutSeconds: 30 },
    { name: "hangup", idempotent: true, timeoutSeconds: 30 },
    { name: "list-calls", idempotent: true, timeoutSeconds: 60 },
    { name: "health", idempotent: true, timeoutSeconds: 30 },
  ];
  const manifest = {
    ...validManifest(),
    capabilities: [
      "telephony.provider.health.read",
      "telephony.call.start",
      "telephony.call.end",
      "telephony.call-history.read",
    ],
    actions,
    health: { action: "health", timeoutSeconds: 30 },
    contributions: [{
      id: "provider",
      area: "telephony",
      contract: "telephony.provider",
      contractVersion: 1,
      operations: {
        startCall: "dial",
        endCall: "hangup",
        synchronizeCalls: "list-calls",
        health: "health",
      },
    }],
  };
  assertEquals(parseExtensionManifest(manifest).contributions.length, 1);
  assertThrows(
    () =>
      parseExtensionManifest({
        ...manifest,
        actions: actions.map((action) =>
          action.name === "dial" ? { ...action, idempotent: true } : action
        ),
      }),
    Error,
    "idempotency",
  );
});

Deno.test("parseExtensionManifest rejects unknown fields and unsafe paths", () => {
  assertThrows(
    () => parseExtensionManifest({ ...validManifest(), arbitrary: true }),
    Error,
    "unsupported field 'arbitrary'",
  );
  assertThrows(
    () =>
      parseExtensionManifest({
        ...validManifest(),
        runtime: { kind: "deno-worker", entrypoint: "../escape.ts" },
      }),
    Error,
    "safe relative path",
  );
});

Deno.test("parseExtensionManifest rejects duplicate actions and undeclared health actions", () => {
  assertThrows(
    () =>
      parseExtensionManifest({
        ...validManifest(),
        actions: [
          { name: "status", idempotent: true, timeoutSeconds: 5 },
          { name: "status", idempotent: true, timeoutSeconds: 5 },
        ],
      }),
    Error,
    "declared more than once",
  );
  assertThrows(
    () =>
      parseExtensionManifest({
        ...validManifest(),
        health: { action: "missing", timeoutSeconds: 5 },
      }),
    Error,
    "is not declared",
  );
});

Deno.test("parseExtensionManifest requires exact network targets and secret names", () => {
  assertThrows(
    () =>
      parseExtensionManifest({
        ...validManifest(),
        permissions: { network: ["https://fritz.box"], secrets: [] },
      }),
    Error,
    "exact host",
  );
  assertThrows(
    () =>
      parseExtensionManifest({
        ...validManifest(),
        permissions: { network: [], secrets: ["password"] },
      }),
    Error,
    "upper snake case",
  );
});
