import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { ExtensionReleaseVerifier } from "./extension-integrity.ts";
import { computeExtensionDigest } from "./extension-integrity.ts";
import { ExtensionManager } from "./extension-manager.ts";
import { readExtensionManifest } from "./extension-manifest.ts";
import { StaticExtensionPolicy } from "./extension-policy.ts";
import { ExtensionStateStore } from "./extension-state.ts";

Deno.test("ExtensionManager installs, executes, updates and removes an isolated extension", async () => {
  const root = await Deno.makeTempDir();
  const source = `${root}/source`;
  const data = `${root}/data`;
  await writePackage(source, "1.0.0", "v1");
  const manager = createManager(data);
  try {
    await manager.initialize();
    await manager.install({
      sourceDirectory: source,
      release: await release(source, "1.0.0"),
      grant: diagnosticsGrant,
      configuration: { enabled: true },
      activate: true,
    });
    assertEquals(
      await manager.execute("request-1", "system.diagnostics", "status", null),
      {
        version: "v1",
        enabled: true,
      },
    );

    await writePackage(source, "2.0.0", "v2");
    const secondRelease = await release(source, "2.0.0");
    await assertRejects(
      () =>
        manager.install({
          sourceDirectory: source,
          release: secondRelease,
          grant: diagnosticsGrant,
          configuration: { enabled: "not-a-boolean" },
          activate: true,
        }),
      Error,
      "does not satisfy the signed schema",
    );
    assertEquals(
      await manager.execute(
        "request-still-v1",
        "system.diagnostics",
        "status",
        null,
      ),
      {
        version: "v1",
        enabled: true,
      },
    );
    await manager.install({
      sourceDirectory: source,
      release: secondRelease,
      grant: diagnosticsGrant,
      configuration: { enabled: false },
      activate: true,
    });
    assertEquals(
      await manager.execute("request-2", "system.diagnostics", "status", null),
      {
        version: "v2",
        enabled: false,
      },
    );

    await manager.reconfigure("system.diagnostics", {
      configuration: { enabled: true },
    });
    assertEquals(
      await manager.execute(
        "request-reconfigured",
        "system.diagnostics",
        "status",
        null,
      ),
      { version: "v2", enabled: true },
    );

    const rolledBack = await manager.rollback("system.diagnostics", "1.0.0");
    assertEquals(rolledBack.version, "1.0.0");
    assertEquals(
      await manager.execute(
        "request-rollback",
        "system.diagnostics",
        "status",
        null,
      ),
      { version: "v1", enabled: true },
    );

    await manager.disable("system.diagnostics");
    assertThrows(
      () => manager.execute("request-3", "system.diagnostics", "status", null),
      Error,
      "not active",
    );
    await manager.activate("system.diagnostics");
    assertEquals(manager.list()[0].status, "ACTIVE");
    await manager.uninstall("system.diagnostics");
    assertEquals(manager.list(), []);
  } finally {
    manager.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ExtensionManager preserves the active release when candidate health fails", async () => {
  const root = await Deno.makeTempDir();
  const source = `${root}/source`;
  const data = `${root}/data`;
  await writePackage(source, "1.0.0", "healthy");
  const manager = createManager(data);
  try {
    await manager.initialize();
    await manager.install({
      sourceDirectory: source,
      release: await release(source, "1.0.0"),
      grant: diagnosticsGrant,
      configuration: {},
      activate: true,
    });
    await writeFailingPackage(source, "2.0.0");
    const failingRelease = await release(source, "2.0.0");
    await assertRejects(
      () =>
        manager.install({
          sourceDirectory: source,
          release: failingRelease,
          grant: diagnosticsGrant,
          configuration: {},
          activate: true,
        }),
      Error,
      "Extension action failed",
    );
    assertEquals(
      await manager.execute("request-4", "system.diagnostics", "status", null),
      { version: "healthy" },
    );
  } finally {
    manager.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ExtensionManager prevents concurrent ownership of one data directory", async () => {
  const root = await Deno.makeTempDir();
  const first = createManager(root);
  const second = createManager(root);
  try {
    await first.initialize();
    await assertRejects(
      () => second.initialize(),
      Error,
      "already owns",
    );
  } finally {
    first.stop();
    second.stop();
    await Deno.remove(root, { recursive: true });
  }
});

const diagnosticsGrant = {
  capabilities: ["system.diagnostics.read"],
  network: [],
  secrets: [],
};

const acceptingVerifier: ExtensionReleaseVerifier = {
  verify: async (directory, manifest, descriptor) => {
    assertEquals(descriptor.extensionId, manifest.id);
    assertEquals(descriptor.version, manifest.version);
    assertEquals(descriptor.digest, await computeExtensionDigest(directory));
  },
};

function createManager(dataDirectory: string): ExtensionManager {
  return new ExtensionManager({
    dataDirectory,
    stateStore: new ExtensionStateStore(
      `${dataDirectory}/state/extensions.json`,
    ),
    verifier: acceptingVerifier,
    policy: new StaticExtensionPolicy([{
      extensionId: "system.diagnostics",
      publishers: ["FLAMOX365"],
      capabilities: ["system.diagnostics.read"],
      network: [],
      secrets: [],
    }]),
    secrets: { resolve: () => Promise.resolve({}) },
  });
}

async function release(directory: string, version: string) {
  const manifest = await readExtensionManifest(directory);
  return {
    extensionId: manifest.id,
    version,
    digest: await computeExtensionDigest(directory),
    publisher: manifest.publisher,
    publisherKeyId: "test-key",
    signature: "test-signature",
  };
}

async function writePackage(
  directory: string,
  version: string,
  output: string,
): Promise<void> {
  await writeManifest(directory, version);
  await Deno.writeTextFile(
    `${directory}/extension.js`,
    `export default { actions: { status: (ctx) => ({ version: ${
      JSON.stringify(output)
    }, ...(ctx.configuration.enabled === undefined ? {} : { enabled: ctx.configuration.enabled }) }) } };\n`,
  );
}

async function writeFailingPackage(
  directory: string,
  version: string,
): Promise<void> {
  await writeManifest(directory, version);
  await Deno.writeTextFile(
    `${directory}/extension.js`,
    "export default { actions: { status: () => { throw new Error('unhealthy'); } } };\n",
  );
}

async function writeManifest(
  directory: string,
  version: string,
): Promise<void> {
  await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    `${directory}/extension-manifest.json`,
    JSON.stringify({
      schemaVersion: 2,
      id: "system.diagnostics",
      displayName: "Diagnostics",
      description: "Reports diagnostic state.",
      publisher: "FLAMOX365",
      version,
      runtime: { kind: "deno-worker", entrypoint: "extension.js" },
      configurationSchema: "configuration.schema.json",
      capabilities: ["system.diagnostics.read"],
      permissions: { network: [], secrets: [] },
      actions: [{ name: "status", idempotent: true, timeoutSeconds: 5 }],
      health: { action: "status", timeoutSeconds: 5 },
    }),
  );
  await Deno.writeTextFile(
    `${directory}/configuration.schema.json`,
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: { enabled: { type: "boolean" } },
    }),
  );
}
