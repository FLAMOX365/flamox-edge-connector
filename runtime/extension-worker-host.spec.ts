import { assertEquals, assertRejects } from "@std/assert";
import type { JsonValue } from "../sdk/extension.ts";
import { parseExtensionManifest } from "./extension-manifest.ts";
import { ExtensionWorkerHost } from "./extension-worker-host.ts";

Deno.test("ExtensionWorkerHost executes a declared action with scoped configuration and secrets", async () => {
  const directory = await Deno.makeTempDir();
  const manifest = parseExtensionManifest({
    schemaVersion: 2,
    id: "system.diagnostics",
    displayName: "Diagnostics",
    description: "Reports diagnostic state.",
    publisher: "FLAMOX365",
    version: "1.0.0",
    runtime: { kind: "deno-worker", entrypoint: "extension.js" },
    capabilities: ["system.diagnostics.read"],
    permissions: { network: [], secrets: ["DIAGNOSTIC_TOKEN"] },
    actions: [{ name: "status", idempotent: true, timeoutSeconds: 5 }],
    health: { action: "status", timeoutSeconds: 5 },
  });
  await Deno.writeTextFile(
    `${directory}/extension.js`,
    `globalThis.postMessage({ type: "ready", actions: ["status"] });
        globalThis.onmessage = () => globalThis.postMessage({ type: "result", executionId: "forged", output: "forged" });
        export default {
          actions: {
            status: (ctx, input) => ({ input, mode: ctx.configuration.mode, token: ctx.secrets.DIAGNOSTIC_TOKEN })
          }
        };\n`,
  );
  const host = new ExtensionWorkerHost({
    extensionDirectory: directory,
    manifest,
    grant: {
      capabilities: [...manifest.capabilities],
      network: [],
      secrets: ["DIAGNOSTIC_TOKEN"],
    },
    configuration: { mode: "safe" },
    secrets: {
      resolve: () => Promise.resolve({ DIAGNOSTIC_TOKEN: "local-only" }),
    },
  });
  try {
    assertEquals(await host.execute("request-1", "status", { test: true }), {
      input: { test: true },
      mode: "safe",
      token: "local-only",
    });
    await assertRejects(
      () => host.execute("request-2", "missing", null),
      Error,
      "not declared",
    );
  } finally {
    host.stop();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("ExtensionWorkerHost brokers only declared host capabilities", async () => {
  const directory = await Deno.makeTempDir();
  const calls: JsonValue[] = [];
  const manifest = parseExtensionManifest({
    schemaVersion: 2,
    id: "system.message",
    displayName: "Message",
    description: "Displays a controlled message.",
    publisher: "FLAMOX365",
    version: "1.0.0",
    runtime: { kind: "deno-worker", entrypoint: "extension.js" },
    capabilities: ["host.ui.message-box"],
    permissions: { network: [], secrets: [] },
    actions: [{ name: "show", idempotent: false, timeoutSeconds: 5 }],
  });
  await Deno.writeTextFile(
    `${directory}/extension.js`,
    `export default {
      actions: {
        show: async (ctx, input) => await ctx.host.ui.showMessage(input)
      }
    };\n`,
  );
  const host = new ExtensionWorkerHost({
    extensionDirectory: directory,
    manifest,
    grant: {
      capabilities: [...manifest.capabilities],
      network: [],
      secrets: [],
    },
    configuration: {},
    secrets: { resolve: () => Promise.resolve({}) },
    hostCapabilities: {
      invoke: (call) => {
        calls.push(call.input);
        return Promise.resolve({ displayed: true });
      },
    },
  });
  try {
    assertEquals(
      await host.execute("request-1", "show", {
        title: "Hello",
        message: "World",
      }),
      { displayed: true },
    );
    assertEquals(calls, [{ title: "Hello", message: "World" }]);
  } finally {
    host.stop();
    await Deno.remove(directory, { recursive: true });
  }
});
