import { assertEquals } from "@std/assert";
import { ExtensionStateStore } from "./extension-state.ts";

Deno.test("ExtensionStateStore atomically persists sorted non-secret state", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = new ExtensionStateStore(`${directory}/state/extensions.json`);
    assertEquals(await store.load(), []);
    await store.save([{
      managementMode: "LOCAL",
      extensionId: "system.diagnostics",
      version: "1.0.0",
      packagePath: "packages/system.diagnostics/1.0.0/sha256-test",
      status: "DISABLED",
      release: {
        extensionId: "system.diagnostics",
        version: "1.0.0",
        digest: `sha256:${"a".repeat(64)}`,
        publisher: "FLAMOX365",
        publisherKeyId: "publisher-1",
        signature: "signature",
      },
      grant: { capabilities: [], network: [], secrets: [] },
      configuration: { visible: true },
      installedAt: "2026-01-01T00:00:00.000Z",
      activatedAt: null,
      lastErrorCode: null,
    }]);

    const loaded = await store.load();
    assertEquals(loaded[0].extensionId, "system.diagnostics");
    assertEquals(loaded[0].configuration, { visible: true });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
