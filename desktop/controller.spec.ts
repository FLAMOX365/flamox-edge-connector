import { assertEquals, assertMatch, assertRejects } from "@std/assert";
import {
  ConnectorIdentityStore,
  generateConnectorKeyPair,
} from "../runtime/connector-identity.ts";
import { ConnectorControlStateStore } from "../runtime/control-state.ts";
import {
  defaultSettings,
  DesktopConnectorController,
  parseSettings,
} from "./controller.ts";

Deno.test("desktop controller persists validated settings without starting a second runtime", async () => {
  const root = await Deno.makeTempDir();
  const settingsPath = `${root}/config/settings.json`;
  try {
    const controller = await DesktopConnectorController.create(settingsPath);
    const settings = {
      ...defaultSettings(),
      dataDirectory: `${root}/data`,
      functionsDirectory: `${root}/functions`,
      displayName: "Desktop Integration Test",
      bindPort: 18_080,
    };
    const state = await controller.saveSettings(settings);
    assertEquals(state.running, false);
    assertEquals(state.settings.displayName, "Desktop Integration Test");
    assertEquals(
      JSON.parse(await Deno.readTextFile(settingsPath)).bindPort,
      18_080,
    );
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(settingsPath)).mode! & 0o777, 0o600);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("desktop publisher workflow generates, signs and packs a customer extension", async () => {
  const root = await Deno.makeTempDir();
  try {
    const controller = await DesktopConnectorController.create(
      `${root}/settings.json`,
    );
    const source = `${root}/extension`;
    await Deno.mkdir(source);
    await Deno.writeTextFile(
      `${source}/extension-manifest.json`,
      JSON.stringify({
        schemaVersion: 2,
        id: "customer.desktop-test",
        displayName: "Desktop test",
        description: "Tests the visual publisher workflow.",
        publisher: "Customer GmbH",
        version: "1.0.0",
        runtime: { kind: "deno-worker", entrypoint: "main.ts" },
        capabilities: [],
        permissions: { network: [], configuredNetwork: [], secrets: [] },
        actions: [{
          name: "echo",
          idempotent: true,
          timeoutSeconds: 10,
        }],
        translations: {},
      }),
    );
    await Deno.writeTextFile(
      `${source}/main.ts`,
      "export default { actions: { echo: (_context: unknown, input: unknown) => input } };\n",
    );
    const pair = await controller.generatePublisher(
      "Customer GmbH",
      "customer-2026",
    );
    const releaseBytes = await controller.sign(
      source,
      pair.privateKey,
      "customer-2026",
    );
    const release = JSON.parse(new TextDecoder().decode(releaseBytes));
    assertMatch(release.digest, /^sha256:[0-9a-f]{64}$/u);
    const bundle = JSON.parse(
      new TextDecoder().decode(await controller.pack(source, release)),
    );
    assertEquals(bundle.release.extensionId, "customer.desktop-test");
    assertEquals(
      bundle.mediaType,
      "application/vnd.flamox.edge-extension+json",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("desktop settings reject insecure remote management by default", async () => {
  await assertRejects(
    () =>
      Promise.resolve().then(() =>
        parseSettings({
          ...defaultSettings(),
          managementUrl: "http://remote.example/api/v1/",
        })
      ),
    Error,
    "https:",
  );
});

Deno.test("desktop shows the persisted tenant pairing while the runtime is stopped", async () => {
  const root = await Deno.makeTempDir();
  const settingsPath = `${root}/settings.json`;
  try {
    const first = await DesktopConnectorController.create(settingsPath);
    await first.saveSettings({
      ...defaultSettings(),
      dataDirectory: `${root}/data`,
      functionsDirectory: `${root}/functions`,
    });
    const keys = await generateConnectorKeyPair();
    await new ConnectorIdentityStore(
      `${root}/data/identity/connector.json`,
    ).save({
      schemaVersion: 1,
      connectorId: "019b3ea9-7770-7000-8000-000000000001",
      tenantId: "42",
      credentialSecret: "secret-that-is-never-returned-by-desktop-state",
      ...keys,
      pairedAt: "2026-07-30T12:00:00.000Z",
    });
    await new ConnectorControlStateStore(
      `${root}/data/state/control.json`,
    ).save({ schemaVersion: 1, desiredRevision: 7, commandSequence: 11 });

    // act
    const state = (await DesktopConnectorController.create(settingsPath))
      .state();

    // assert
    assertEquals(state.running, false);
    assertEquals(state.managedConnection?.tenantId, "42");
    assertEquals(state.managedConnection?.desiredRevision, 7);
    assertEquals(state.managedConnection?.commandSequence, 11);
    assertEquals(
      JSON.stringify(state).includes("secret-that-is-never-returned"),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
