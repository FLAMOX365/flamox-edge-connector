import { test } from "node:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSettings } from "./controller.ts";
import { assertEquals, assert, assertRejects } from "../test/assert.ts";
import {
  generatePublisherKey,
  signExtensionRelease,
} from "../runtime/extension-publisher.ts";
import { createExtensionBundle } from "../runtime/extension-bundle.ts";

test("compiled desktop backend persists isolated settings, pushes changes and transports keys", {
  timeout: 15_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "edge-desktop-ipc-"));
  const path = join(directory, "settings.json");
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const source = join(directory, "extension");
  await mkdir(source);
  const grant = {
    capabilities: ["host.ui.message-box"],
    network: [],
    secrets: [],
  };
  await writeFile(
    join(source, "extension-manifest.json"),
    JSON.stringify({
      schemaVersion: 2,
      id: "test.desktop-ipc",
      displayName: "IPC Test",
      description: "Exercises signed installation and brokered dialogs.",
      publisher: "FLAMOX365",
      version: "1.0.0",
      runtime: { kind: "node-process", entrypoint: "extension.mjs" },
      capabilities: grant.capabilities,
      permissions: { network: [], secrets: [] },
      actions: [{ name: "show", idempotent: false, timeoutSeconds: 5 }],
    }),
  );
  await writeFile(
    join(source, "extension.mjs"),
    "export default { actions: { show: (context, input) => context.host.ui.showMessage(input) } };",
  );
  const pair = await generatePublisherKey("FLAMOX365", "ipc-test");
  await writeFile(join(directory, "trust.json"), JSON.stringify(pair.trust));
  await writeFile(
    join(directory, "policy.json"),
    JSON.stringify({
      schemaVersion: 1,
      extensions: [
        {
          extensionId: "test.desktop-ipc",
          publishers: ["FLAMOX365"],
          ...grant,
        },
      ],
    }),
  );
  const bundle = await createExtensionBundle(
    source,
    await signExtensionRelease(source, pair.privateKey, "ipc-test"),
  );
  const events = new EventEmitter();
  const cloud = createHttpServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    response.setHeader("content-type", "application/json");
    let value: unknown = {};
    if (pathname.endsWith("/pair"))
      value = {
        connectorId: "ipc-connector",
        tenantId: "ipc-tenant",
        credentialSecret: "disposable-ipc-credential",
      };
    else if (pathname.endsWith("/desired"))
      value = {
        schemaVersion: 1,
        revision: 1,
        publisherTrust: pair.trust,
        extensionPolicy: {
          schemaVersion: 1,
          extensions: [
            {
              extensionId: "test.desktop-ipc",
              publishers: ["FLAMOX365"],
              ...grant,
            },
          ],
        },
        extensions: [
          {
            extensionId: "test.desktop-ipc",
            version: "1.0.0",
            status: "ACTIVE",
            bundleUrl: "/bundle",
            grant,
            configuration: {},
            secrets: {},
          },
        ],
      };
    else if (pathname.endsWith("/commands"))
      value = { schemaVersion: 1, commands: [] };
    else if (pathname === "/bundle") value = bundle;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (pathname.endsWith("/observed"))
      events.emit("observed", JSON.parse(Buffer.concat(chunks).toString()));
    response.end(JSON.stringify(value));
  });
  await new Promise<void>((resolve) => cloud.listen(0, "127.0.0.1", resolve));
  const cloudPort = (cloud.address() as AddressInfo).port;
  const observed = once(events, "observed");
  await writeFile(
    path,
    JSON.stringify({
      ...defaultSettings(),
      bindPort: port,
      managementUrl: `http://127.0.0.1:${cloudPort}/api/v1/`,
      pairingCode: "disposable-ipc-pairing-code",
      allowInsecureConnections: true,
      trustedPublishersFile: join(directory, "trust.json"),
      extensionPolicyFile: join(directory, "policy.json"),
      dataDirectory: join(directory, "data"),
      functionsDirectory: join(directory, "functions"),
    }),
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../dist/desktop/main.js", import.meta.url)),
      "--settings",
      path,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stderr.resume();
  const closed = once(child, "exit");
  const replies = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  let sequence = 0,
    invalidations = 0;
  let displayDialog = true;
  const dialogs: unknown[] = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line) as {
      type: string;
      id: string;
      result?: unknown;
      error?: string;
      request?: unknown;
    };
    if (message.type === "state-changed") {
      invalidations++;
      return;
    }
    if (message.type === "ui-request") {
      dialogs.push(message.request);
      child.stdin.write(
        `${JSON.stringify({ type: "ui-result", id: message.id, displayed: displayDialog })}\n`,
      );
      return;
    }
    const reply = replies.get(message.id);
    replies.delete(message.id);
    if (message.error) reply?.reject(new Error(message.error));
    else reply?.resolve(message.result);
  });
  const request = (method: string, ...args: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = String(++sequence);
      replies.set(id, { resolve, reject });
      child.stdin.write(
        `${JSON.stringify({ type: "request", id, method, args })}\n`,
      );
    });
  try {
    const initial = (await request("getState")) as {
      running: boolean;
      settings: Record<string, unknown>;
    };
    assertEquals(initial.running, false);
    const settings = { ...initial.settings, displayName: "Lokaler IPC-Test" };
    await request("saveSettings", settings);
    assertEquals(
      JSON.parse(await readFile(path, "utf8")).displayName,
      "Lokaler IPC-Test",
    );
    assert(invalidations > 0, "Saving must push a state invalidation.");
    const keys = (await request(
      "generatePublisherKey",
      "FLAMOX365",
      "ipc-test",
    )) as {
      privateKey: { encoding: string; data: string };
      trust: { data: string };
    };
    assertEquals(keys.privateKey.encoding, "base64");
    assertEquals(
      JSON.parse(Buffer.from(keys.privateKey.data, "base64").toString()).kty,
      "OKP",
    );
    await assertRejects(
      () => request("unrecognizedOperation"),
      Error,
      "Unknown desktop operation",
    );
    await assertRejects(
      () => request("installBundle", { bytes: "invalid base64!" }),
      Error,
      "Invalid binary",
    );
    await request("startConnector");
    const [report] = await observed;
    assertEquals(report.extensions[0].observedStatus, "ACTIVE");
    const message = {
      title: "IPC validation",
      message: "Brokered local dialog",
      kind: "info",
    };
    assertEquals(
      await request("executeAction", {
        extensionId: "test.desktop-ipc",
        action: "show",
        input: message,
      }),
      { displayed: true },
    );
    assertEquals(dialogs, [message]);
    displayDialog = false;
    await assertRejects(
      () =>
        request("executeAction", {
          extensionId: "test.desktop-ipc",
          action: "show",
          input: message,
        }),
      Error,
      "Extension action failed",
    );
    displayDialog = true;
    assertEquals(
      await request("executeAction", {
        extensionId: "test.desktop-ipc",
        action: "show",
        input: message,
      }),
      { displayed: true },
    );
    await request("stopConnector");
    child.stdin.end();
    assertEquals((await closed)[0], 0);
  } finally {
    child.kill();
    lines.close();
    cloud.closeAllConnections();
    await new Promise<void>((resolve) => cloud.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

for (const frame of [
  "{",
  "null",
  "[]",
  JSON.stringify({ type: "request", id: "1", method: "getState", args: {} }),
  JSON.stringify({
    type: "request",
    id: "1",
    method: "getState",
    args: [1, 2, 3, 4, 5],
  }),
]) {
  test(`compiled desktop backend closes malformed IPC without persisting settings: ${frame}`, {
    timeout: 5_000,
  }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "edge-ipc-invalid-"));
    const path = join(directory, "settings.json");
    const settings = {
      ...defaultSettings(),
      dataDirectory: join(directory, "data"),
      functionsDirectory: join(directory, "functions"),
    };
    await writeFile(path, JSON.stringify(settings));
    const before = await readFile(path);
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../dist/desktop/main.js", import.meta.url)),
        "--settings",
        path,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdout.resume();
    child.stderr.resume();
    t.after(async () => {
      child.kill();
      await rm(directory, { recursive: true, force: true });
    });
    const closed = once(child, "exit");
    child.stdin.write(`${frame}\n`);
    assertEquals((await closed)[0], 0);
    assertEquals(await readFile(path), before);
  });
}

test("compiled desktop backend serializes mutations and rejects invalid settings without changing disk", {
  timeout: 5_000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "edge-ipc-queue-"));
  const path = join(directory, "settings.json");
  const settings = {
    ...defaultSettings(),
    dataDirectory: join(directory, "data"),
    functionsDirectory: join(directory, "functions"),
  };
  await writeFile(path, JSON.stringify(settings));
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../dist/desktop/main.js", import.meta.url)),
      "--settings",
      path,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stderr.resume();
  const closed = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const responses: {
    id: string;
    result?: { settings: typeof settings };
    error?: string;
  }[] = [];
  let completed!: () => void;
  const complete = new Promise<void>((resolve) => {
    completed = resolve;
  });
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    if (value.type === "response") {
      responses.push(value);
      if (responses.length === 4) completed();
    }
  });
  t.after(async () => {
    child.kill();
    lines.close();
    await rm(directory, { recursive: true, force: true });
  });
  for (const [id, method, args] of [
    ["one", "saveSettings", [{ ...settings, displayName: "First" }]],
    ["two", "saveSettings", [{ ...settings, displayName: "Second" }]],
    ["invalid", "saveSettings", [{ ...settings, bindPort: "invalid" }]],
    ["read", "getState", []],
  ])
    child.stdin.write(
      `${JSON.stringify({ type: "request", id, method, args })}\n`,
    );
  await complete;
  assertEquals(
    responses.map((response) => response.id),
    ["one", "two", "invalid", "read"],
  );
  assert(typeof responses[2]!.error === "string");
  assertEquals(responses[3]!.result!.settings.displayName, "Second");
  assertEquals(JSON.parse(await readFile(path, "utf8")).displayName, "Second");
  child.stdin.end();
  assertEquals((await closed)[0], 0);
});
