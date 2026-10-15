import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { makeTempDirectory } from "./files.ts";
import { ExtensionManager } from "./extension-manager.ts";
import { ExtensionReconciler } from "./extension-reconciler.ts";
import { ExtensionStateStore } from "./extension-state.ts";
import { ManagedExtensionPolicy } from "./extension-policy.ts";
import { ManagedExtensionReleaseVerifier } from "./extension-integrity.ts";
import { ManagedExtensionSecretProvider } from "./extension-secrets.ts";
import { ConnectorAuditLog } from "./audit-log.ts";
import { generateConnectorKeyPair } from "./connector-identity.ts";
import { ControlPlaneClient } from "./control-plane-client.ts";
import {
  generatePublisherKey,
  signExtensionRelease,
} from "./extension-publisher.ts";
import {
  createExtensionBundle,
  type ExtensionBundle,
} from "./extension-bundle.ts";
import type {
  ConnectorDesiredState,
  DesiredExtension,
} from "./control-plane-contract.ts";
import { createLogger } from "./logger.ts";

async function fixture(t: TestContext) {
  const directory = await makeTempDirectory("edge-reconcile-test-");
  const source = join(directory, "source"),
    data = join(directory, "data");
  await fs.mkdir(source);
  const publisher = await generatePublisherKey(
    "FLAMOX365",
    "fixture-publisher",
  );
  const identity = {
    schemaVersion: 1 as const,
    connectorId: "fixture-connector",
    tenantId: "fixture-tenant",
    credentialSecret: "fixture-credential",
    pairedAt: "2026-10-15T10:00:00.000Z",
    ...(await generateConnectorKeyPair()),
  };
  const grant = { capabilities: [], network: [], secrets: ["TOKEN"] };
  const extensionId = "test.reconciliation";
  const policyDocument = {
    schemaVersion: 1,
    extensions: [{ extensionId, publishers: ["FLAMOX365"], ...grant }],
  };
  const policy = new ManagedExtensionPolicy(),
    verifier = new ManagedExtensionReleaseVerifier(),
    secrets = new ManagedExtensionSecretProvider();
  const auditPath = join(data, "audit.json"),
    statePath = join(data, "state.json");
  const audit = new ConnectorAuditLog(auditPath);
  await audit.initialize();
  const bundles = new Map<string, ExtensionBundle>();
  const downloads: string[] = [];
  const server = createServer((request, response) => {
    assert.equal(
      request.headers.authorization,
      "EdgeConnector fixture-connector.fixture-credential",
    );
    downloads.push(request.url!);
    const bundle = bundles.get(request.url!);
    response.writeHead(bundle ? 200 : 404, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify(bundle ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new ControlPlaneClient(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    identity,
  );
  const newManager = () =>
    new ExtensionManager({
      dataDirectory: data,
      stateStore: new ExtensionStateStore(statePath),
      verifier,
      policy,
      secrets,
      logger: createLogger("error", {
        info() {},
        debug() {},
        warn() {},
        error() {},
      }),
    });
  let manager = newManager();
  await manager.initialize();
  t.after(async () => {
    manager.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    identity.publicKey,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const envelope = {
    algorithm: "RSA-OAEP-256" as const,
    ciphertext: Buffer.from(
      await crypto.subtle.encrypt(
        { name: "RSA-OAEP" },
        publicKey,
        new TextEncoder().encode("fixture-secret"),
      ),
    ).toString("base64"),
  };
  const desiredExtension = (version = "1.0.0"): DesiredExtension => ({
    extensionId,
    version,
    status: "ACTIVE",
    bundleUrl: `/${version}.fmx`,
    grant,
    configuration: { mode: "first" },
    secrets: { TOKEN: envelope },
  });
  const desired = (
    extensions: readonly DesiredExtension[],
  ): ConnectorDesiredState => ({
    schemaVersion: 1,
    revision: 1,
    publisherTrust: publisher.trust,
    extensionPolicy: policyDocument,
    extensions,
  });
  const reconciler = () =>
    new ExtensionReconciler(
      manager,
      verifier,
      policy,
      secrets,
      identity,
      client,
      audit,
    );
  const packageRelease = async (version: string, unhealthy = false) => {
    await fs.writeFile(
      join(source, "extension-manifest.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: extensionId,
        displayName: "Reconciliation",
        description: "Disposable integration fixture",
        publisher: "FLAMOX365",
        version,
        runtime: { kind: "node-process", entrypoint: "extension.mjs" },
        capabilities: [],
        permissions: { network: [], secrets: ["TOKEN"] },
        configurationSchema: "configuration.schema.json",
        actions: [{ name: "inspect", idempotent: true, timeoutSeconds: 5 }],
        health: { action: "inspect", timeoutSeconds: 5 },
      }),
    );
    await fs.writeFile(
      join(source, "configuration.schema.json"),
      JSON.stringify({
        type: "object",
        additionalProperties: false,
        required: ["mode"],
        properties: { mode: { type: "string" } },
      }),
    );
    await fs.writeFile(
      join(source, "extension.mjs"),
      unhealthy
        ? 'export default { actions: { inspect: () => { throw new Error("unhealthy"); } } };'
        : `export default { actions: { inspect: context => ({ version: ${JSON.stringify(version)}, mode: context.configuration.mode, token: context.secrets.TOKEN }) } };`,
    );
    const release = await signExtensionRelease(
      source,
      publisher.privateKey,
      "fixture-publisher",
    );
    const bundle = await createExtensionBundle(source, release);
    bundles.set(`/${version}.fmx`, bundle);
    return { release, bundle };
  };
  return {
    source,
    extensionId,
    grant,
    policy,
    verifier,
    policyDocument,
    secrets,
    audit,
    auditPath,
    statePath,
    bundles,
    downloads,
    desired,
    desiredExtension,
    packageRelease,
    reconciler,
    get manager() {
      return manager;
    },
    async restart() {
      manager.stop();
      manager = newManager();
      await manager.initialize();
    },
  };
}

test("managed reconciliation installs a signed HTTP bundle, stays idempotent, reconfigures, disables and restores after restart", {
  timeout: 15_000,
}, async (t) => {
  const f = await fixture(t);
  await f.packageRelease("1.0.0");
  const active = f.desiredExtension();
  assert.equal(
    (await f.reconciler().reconcile(f.desired([active]))).complete,
    true,
  );
  assert.deepEqual(
    await f.manager.execute("first", f.extensionId, "inspect", null),
    { version: "1.0.0", mode: "first", token: "fixture-secret" },
  );
  assert.equal(
    (await f.reconciler().reconcile(f.desired([active]))).complete,
    true,
  );
  assert.deepEqual(f.downloads, ["/1.0.0.fmx"]);
  assert.equal(
    f.audit.list().filter((event) => event.type === "extension.install").length,
    1,
  );
  const changed = { ...active, configuration: { mode: "updated" } };
  await f.reconciler().reconcile(f.desired([changed]));
  assert.deepEqual(
    await f.manager.execute("updated", f.extensionId, "inspect", null),
    { version: "1.0.0", mode: "updated", token: "fixture-secret" },
  );
  await f
    .reconciler()
    .reconcile(f.desired([{ ...changed, status: "DISABLED" }]));
  assert.equal(f.manager.list()[0]!.status, "DISABLED");
  assert.throws(
    () => f.manager.execute("disabled", f.extensionId, "inspect", null),
    /not active/,
  );
  await f.restart();
  assert.equal(f.manager.list()[0]!.status, "DISABLED");
  await f.reconciler().reconcile(f.desired([changed]));
  assert.deepEqual(
    await f.manager.execute("restored", f.extensionId, "inspect", null),
    { version: "1.0.0", mode: "updated", token: "fixture-secret" },
  );
  assert.equal(
    (await fs.readFile(f.statePath, "utf8")).includes("fixture-secret"),
    false,
  );
  assert.equal(
    (await fs.readFile(f.auditPath, "utf8")).includes("fixture-secret"),
    false,
  );
  await f.reconciler().reconcile(f.desired([]));
  assert.deepEqual(f.manager.list(), []);
  await assert.rejects(
    () => f.secrets.resolve(f.extensionId, ["TOKEN"]),
    /not available/,
  );
});

test("managed update rejects unhealthy or tampered candidates while retaining the active package and configuration", {
  timeout: 15_000,
}, async (t) => {
  const f = await fixture(t);
  await f.packageRelease("1.0.0");
  await f.reconciler().reconcile(f.desired([f.desiredExtension()]));
  await f.packageRelease("2.0.0", true);
  const unhealthy = await f.reconciler().reconcile(
    f.desired([
      {
        ...f.desiredExtension("2.0.0"),
        configuration: { mode: "candidate" },
      },
    ]),
  );
  assert.equal(unhealthy.complete, false);
  assert.equal(unhealthy.observations[0]!.observedVersion, "1.0.0");
  assert.deepEqual(
    await f.manager.execute("retained", f.extensionId, "inspect", null),
    { version: "1.0.0", mode: "first", token: "fixture-secret" },
  );
  const { bundle } = await f.packageRelease("3.0.0");
  f.bundles.set("/3.0.0.fmx", {
    ...bundle,
    files: bundle.files.map((file) =>
      file.path === "extension.mjs"
        ? {
            ...file,
            contentBase64: Buffer.from(
              'export default { actions: { inspect: () => "tampered" } };',
            ).toString("base64"),
          }
        : file,
    ),
  });
  const tampered = await f
    .reconciler()
    .reconcile(f.desired([f.desiredExtension("3.0.0")]));
  assert.equal(tampered.complete, false);
  assert.equal(tampered.observations[0]!.observedVersion, "1.0.0");
  assert.deepEqual(
    await f.manager.execute("still-original", f.extensionId, "inspect", null),
    { version: "1.0.0", mode: "first", token: "fixture-secret" },
  );
  await f.packageRelease("4.0.0");
  assert.equal(
    (await f.reconciler().reconcile(f.desired([f.desiredExtension("4.0.0")])))
      .complete,
    true,
  );
  assert.equal(f.manager.list()[0]!.version, "4.0.0");
  assert.equal(
    f.audit
      .list()
      .filter(
        (event) =>
          event.type === "extension.reconcile" && event.outcome === "FAILED",
      ).length,
    2,
  );
});

test("managed desired state cannot replace or remove a locally owned installation", async (t) => {
  const f = await fixture(t);
  const { release } = await f.packageRelease("1.0.0");
  // Seed the trust/policy through their real managed update boundaries before local installation.
  await f.reconciler().reconcile(f.desired([]));
  f.secrets.update(f.extensionId, { TOKEN: "local-fixture-secret" });
  await f.manager.install({
    sourceDirectory: f.source,
    release,
    grant: f.grant,
    configuration: { mode: "local" },
    activate: true,
    managementMode: "LOCAL",
  });
  for (const extension of [
    f.desiredExtension(),
    { extensionId: f.extensionId, status: "ABSENT" as const, secrets: {} },
  ]) {
    const result = await f.reconciler().reconcile(f.desired([extension]));
    assert.equal(result.complete, false);
    assert.equal(
      result.observations[0]!.errorCode,
      "LOCAL_EXTENSION_OWNERSHIP_CONFLICT",
    );
  }
  assert.deepEqual(f.downloads, []);
  assert.deepEqual(
    await f.manager.execute("local", f.extensionId, "inspect", null),
    { version: "1.0.0", mode: "local", token: "local-fixture-secret" },
  );
});
