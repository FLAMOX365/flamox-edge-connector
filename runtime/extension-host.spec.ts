import { test } from "node:test";
import { makeTempDirectory } from "./files.ts";
import * as fs from "node:fs/promises";
import { assertEquals, assertRejects } from "../test/assert.ts";
import type { JsonValue } from "@edge-connector/sdk/extension";
import { parseExtensionManifest } from "./extension-manifest.ts";
import { ExtensionHost, type ExtensionHostOptions } from "./extension-host.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer as createTcpServer } from "node:net";
import { build } from "esbuild";

test("ExtensionHost executes a declared action with scoped configuration and secrets", async () => {
  const directory = await makeTempDirectory();
  await fs.writeFile(
    `${directory}/package.json`,
    JSON.stringify({ type: "module" }),
  );
  const manifest = parseExtensionManifest({
    schemaVersion: 2,
    id: "system.diagnostics",
    displayName: "Diagnostics",
    description: "Reports diagnostic state.",
    publisher: "FLAMOX365",
    version: "1.0.0",
    runtime: { kind: "node-process", entrypoint: "extension.mjs" },
    capabilities: ["system.diagnostics.read"],
    permissions: { network: [], secrets: ["DIAGNOSTIC_TOKEN"] },
    actions: [{ name: "status", idempotent: true, timeoutSeconds: 5 }],
    health: { action: "status", timeoutSeconds: 5 },
  });
  await fs.writeFile(
    `${directory}/extension.mjs`,
    `export default {
          actions: {
            status: (ctx, input) => ({ input, mode: ctx.configuration.mode, token: ctx.secrets.DIAGNOSTIC_TOKEN })
          }
        };\n`,
  );
  const host = new ExtensionHost({
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
    await fs.rm(directory, { recursive: true });
  }
});

test("ExtensionHost isolates host files, writes, subprocesses and the parent environment", async () => {
  const directory = await makeTempDirectory("edge-isolation-");
  const outside = await makeTempDirectory("edge-private-");
  const sentinelName = "EDGE_ISOLATION_TEST_PARENT_SECRET";
  const original = process.env[sentinelName];
  process.env[sentinelName] = "parent-only";
  await fs.writeFile(`${directory}/own.txt`, "own-package");
  await fs.writeFile(`${outside}/private.txt`, "private-host-file");
  const source = `
    import { readFile, writeFile } from "node:fs/promises";
    import { execFileSync } from "node:child_process";
    export default { actions: { inspect: async (context, input) => {
      const result = { own: await readFile(new URL("./own.txt", import.meta.url), "utf8"), parentSecret: process.env.${sentinelName} ?? null, secrets: context.secrets };
      try { await readFile(input.outside, "utf8"); result.readDenied = false; } catch { result.readDenied = true; }
      try { await writeFile(new URL("./write.txt", import.meta.url), "forbidden"); result.writeDenied = false; } catch { result.writeDenied = true; }
      try { execFileSync(process.execPath, ["-e", "process.stdout.write('forbidden')"]); result.processDenied = false; } catch { result.processDenied = true; }
      return result;
    } } };`;
  const host = await isolationHost(directory, source, [], ["ALLOWED"]);
  try {
    assertEquals(
      await host.execute("inspect-1", "inspect", {
        outside: `${outside}/private.txt`,
      }),
      {
        own: "own-package",
        parentSecret: null,
        secrets: { ALLOWED: "scoped-only" },
        readDenied: true,
        writeDenied: true,
        processDenied: true,
      },
    );
    await assertRejects(() => fs.stat(`${directory}/write.txt`));
    assertEquals(
      await fs.readFile(`${outside}/private.txt`, "utf8"),
      "private-host-file",
    );
  } finally {
    host.stop();
    if (original === undefined) delete process.env[sentinelName];
    else process.env[sentinelName] = original;
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("ExtensionHost enforces exact network ports and prevents direct socket bypass", async () => {
  let allowedRequests = 0,
    deniedRequests = 0;
  const allowed = createServer((_request, response) => {
    allowedRequests++;
    response.end("allowed");
  });
  const denied = createServer((_request, response) => {
    deniedRequests++;
    response.end("forbidden");
  });
  await Promise.all([
    new Promise<void>((resolve) => allowed.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => denied.listen(0, "127.0.0.1", resolve)),
  ]);
  const allowedPort = (allowed.address() as AddressInfo).port;
  const deniedPort = (denied.address() as AddressInfo).port;
  const directory = await makeTempDirectory("edge-network-");
  const host = await isolationHost(
    directory,
    `
    import http from "node:http";
    export default { actions: { inspect: async (_context, input) => {
      const allowed = await fetch(input.allowed);
      let denied = false;
      try { const response = await fetch(input.denied); denied = !response.ok; await response.body?.cancel(); } catch { denied = true; }
      const directDenied = await new Promise(resolve => {
        const request = http.get(input.denied, { agent: false }, response => { response.resume(); resolve(false); });
        request.once("error", () => resolve(true));
        request.setTimeout(1_000, () => { request.destroy(); resolve(true); });
      });
      return { allowed: await allowed.text(), denied, directDenied };
    } } };`,
    [`127.0.0.1:${allowedPort}`],
  );
  try {
    assertEquals(
      await host.execute("network-1", "inspect", {
        allowed: `http://127.0.0.1:${allowedPort}/`,
        denied: `http://127.0.0.1:${deniedPort}/`,
      }),
      { allowed: "allowed", denied: true, directDenied: true },
    );
    assertEquals(allowedRequests, 1);
    assertEquals(deniedRequests, 0);
  } finally {
    host.stop();
    allowed.closeAllConnections();
    denied.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => allowed.close(() => resolve())),
      new Promise<void>((resolve) => denied.close(() => resolve())),
    ]);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ExtensionHost terminates infinite execution and recovers in a fresh sandbox", async () => {
  const directory = await makeTempDirectory("edge-timeout-");
  const host = await isolationHost(
    directory,
    'export default { actions: { inspect: (_context, input) => { if (input === "loop") while (true) {} return "recovered"; } } };',
  );
  try {
    await assertRejects(
      () => host.execute("timeout-1", "inspect", "loop", 50),
      Error,
      "timed out",
    );
    assertEquals(await host.execute("recover-1", "inspect", null), "recovered");
  } finally {
    host.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ExtensionHost gives native TCP drivers only the grant-filtered SOCKS connection", async () => {
  let deniedConnections = 0;
  const allowed = createTcpServer((socket) => socket.pipe(socket));
  const denied = createTcpServer((socket) => {
    deniedConnections++;
    socket.destroy();
  });
  await Promise.all([
    new Promise<void>((resolve) => allowed.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => denied.listen(0, "127.0.0.1", resolve)),
  ]);
  const allowedPort = (allowed.address() as AddressInfo).port;
  const deniedPort = (denied.address() as AddressInfo).port;
  const directory = await makeTempDirectory("edge-tcp-");
  const compiled = await build({
    stdin: {
      contents: `import { connectTcp } from "@edge-connector/sdk/tcp";
    export default { actions: { inspect: async (_context, input) => {
      let denied = false;
      try { const socket = await connectTcp("127.0.0.1", input.denied, 1000); socket.destroy(); } catch { denied = true; }
      const socket = await connectTcp("127.0.0.1", input.allowed, 1000);
      const echo = await new Promise((resolve, reject) => { socket.once("data", bytes => { socket.destroy(); resolve(bytes.toString()); }); socket.once("error", reject); socket.write("Grüße aus TCP"); });
      return { echo, denied };
    } } };`,
      resolveDir: process.cwd(),
      sourcefile: "tcp-test.mjs",
    },
    write: false,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  });
  const host = await isolationHost(directory, compiled.outputFiles[0]!.text, [
    `127.0.0.1:${allowedPort}`,
  ]);
  try {
    assertEquals(
      await host.execute("tcp-1", "inspect", {
        allowed: allowedPort,
        denied: deniedPort,
      }),
      { echo: "Grüße aus TCP", denied: true },
    );
    assertEquals(deniedConnections, 0);
  } finally {
    host.stop();
    await Promise.all([
      new Promise<void>((resolve) => allowed.close(() => resolve())),
      new Promise<void>((resolve) => denied.close(() => resolve())),
    ]);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ExtensionHost shares one startup between concurrent executions", async () => {
  const directory = await makeTempDirectory("edge-concurrent-");
  const host = await isolationHost(
    directory,
    "let count = 0; export default { actions: { inspect: () => ++count } };",
  );
  try {
    assertEquals(
      (
        await Promise.all([
          host.execute("one", "inspect", null),
          host.execute("two", "inspect", null),
        ])
      ).sort(),
      [1, 2],
    );
  } finally {
    host.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function isolationHost(
  directory: string,
  source: string,
  network: string[] = [],
  secrets: string[] = [],
  options: Partial<ExtensionHostOptions> = {},
): Promise<ExtensionHost> {
  await fs.writeFile(`${directory}/extension.mjs`, source);
  const manifest = parseExtensionManifest({
    schemaVersion: 2,
    id: "test.isolation",
    displayName: "Isolation",
    description: "Exercises the sandbox.",
    publisher: "FLAMOX365",
    version: "1.0.0",
    runtime: { kind: "node-process", entrypoint: "extension.mjs" },
    capabilities: [],
    permissions: { network, secrets },
    actions: [{ name: "inspect", idempotent: true, timeoutSeconds: 5 }],
  });
  return new ExtensionHost({
    extensionDirectory: directory,
    manifest,
    grant: { capabilities: [], network, secrets },
    configuration: {},
    secrets: {
      resolve: () =>
        Promise.resolve(
          Object.fromEntries(secrets.map((name) => [name, "scoped-only"])),
        ),
    },
    ...options,
  });
}

test("ExtensionHost brokers only declared host capabilities", async () => {
  const directory = await makeTempDirectory();
  await fs.writeFile(
    `${directory}/package.json`,
    JSON.stringify({ type: "module" }),
  );
  const calls: JsonValue[] = [];
  const manifest = parseExtensionManifest({
    schemaVersion: 2,
    id: "system.message",
    displayName: "Message",
    description: "Displays a controlled message.",
    publisher: "FLAMOX365",
    version: "1.0.0",
    runtime: { kind: "node-process", entrypoint: "extension.mjs" },
    capabilities: ["host.ui.message-box"],
    permissions: { network: [], secrets: [] },
    actions: [{ name: "show", idempotent: false, timeoutSeconds: 5 }],
  });
  await fs.writeFile(
    `${directory}/extension.mjs`,
    `export default {
      actions: {
        show: async (ctx, input) => await ctx.host.ui.showMessage(input)
      }
    };\n`,
  );
  const host = new ExtensionHost({
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
    await fs.rm(directory, { recursive: true });
  }
});

for (const actions of [
  "{ missing: () => null }",
  "{ inspect: () => null, hidden: () => null }",
]) {
  test(`ExtensionHost rejects an entrypoint with a different signed action set: ${actions}`, async (t) => {
    const directory = await makeTempDirectory();
    const host = await isolationHost(
      directory,
      `export default { actions: ${actions} };`,
    );
    t.after(async () => {
      host.stop();
      await fs.rm(directory, { recursive: true, force: true });
    });
    await assertRejects(() => host.start(), Error, "initialization failed");
  });
}

for (const value of [
  "undefined",
  "NaN",
  "1n",
  "(() => { const value = {}; value.self = value; return value; })()",
]) {
  test(`ExtensionHost rejects non-JSON results and keeps the next execution usable: ${value}`, async (t) => {
    const directory = await makeTempDirectory();
    const host = await isolationHost(
      directory,
      `export default { actions: { inspect: (_context, input) => input ? ${value} : { healthy: true } } };`,
    );
    t.after(async () => {
      host.stop();
      await fs.rm(directory, { recursive: true, force: true });
    });
    await assertRejects(
      () => host.execute("invalid", "inspect", true),
      Error,
      "Extension action failed",
    );
    assertEquals(await host.execute("next", "inspect", false), {
      healthy: true,
    });
  });
}

for (const denied of ["manifest", "grant", "provider"] as const) {
  test(`ExtensionHost denies host UI authority missing from the ${denied} without invoking the provider`, async (t) => {
    const directory = await makeTempDirectory();
    let invocations = 0;
    const base = await isolationHost(
      directory,
      'export default { actions: { inspect: context => context.host.ui.showMessage({ title: "Test", message: "Test" }) } };',
    );
    const capability = "host.ui.message-box";
    const host = await isolationHost(
      directory,
      await fs.readFile(`${directory}/extension.mjs`, "utf8"),
      [],
      [],
      {
        manifest: {
          ...base.manifest,
          capabilities: denied === "manifest" ? [] : [capability],
        },
        grant: {
          capabilities: denied === "grant" ? [] : [capability],
          network: [],
          secrets: [],
        },
        ...(denied === "provider"
          ? {}
          : {
              hostCapabilities: {
                invoke: async () => {
                  invocations++;
                  return { displayed: true };
                },
              },
            }),
      },
    );
    t.after(async () => {
      host.stop();
      await fs.rm(directory, { recursive: true, force: true });
    });
    await assertRejects(
      () => host.execute("denied", "inspect", null),
      Error,
      "Extension action failed",
    );
    assertEquals(invocations, 0);
  });
}

test("ExtensionHost validates signed input before resolving secrets or executing host side effects", async (t) => {
  const directory = await makeTempDirectory();
  let secretsResolved = 0,
    hostCalls = 0;
  const base = await isolationHost(
    directory,
    'export default { actions: { inspect: context => context.host.ui.showMessage({ title: "Test", message: "Test" }) } };',
  );
  await fs.writeFile(
    `${directory}/input.json`,
    JSON.stringify({
      type: "object",
      required: ["count"],
      additionalProperties: false,
      properties: { count: { type: "integer", minimum: 1, maximum: 3 } },
    }),
  );
  const host = await isolationHost(
    directory,
    await fs.readFile(`${directory}/extension.mjs`, "utf8"),
    [],
    [],
    {
      manifest: {
        ...base.manifest,
        capabilities: ["host.ui.message-box"],
        actions: [{ ...base.manifest.actions[0]!, inputSchema: "input.json" }],
      },
      grant: {
        capabilities: ["host.ui.message-box"],
        network: [],
        secrets: [],
      },
      secrets: {
        resolve: async () => {
          secretsResolved++;
          return {};
        },
      },
      hostCapabilities: {
        invoke: async () => {
          hostCalls++;
          return { displayed: true };
        },
      },
    },
  );
  t.after(async () => {
    host.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const invalidInputs: JsonValue[] = [
    { count: "1" },
    { count: 0 },
    { count: 4 },
    { count: 1, extra: true },
  ];
  for (const input of invalidInputs) {
    await assertRejects(
      () => host.execute("invalid", "inspect", input),
      Error,
      "input violates its contract",
    );
  }
  assertEquals([secretsResolved, hostCalls], [0, 0]);
  assertEquals(await host.execute("valid", "inspect", { count: 1 }), {
    displayed: true,
  });
  assertEquals([secretsResolved, hostCalls], [1, 1]);
});

test("ExtensionHost filters an overbroad secret provider and keeps simultaneous contexts separate", async (t) => {
  const directory = await makeTempDirectory();
  const host = await isolationHost(
    directory,
    "export default { actions: { inspect: async (context, input) => { await new Promise(resolve => setTimeout(resolve, input)); return { id: context.requestId, secrets: context.secrets }; } } };",
    [],
    ["ALLOWED"],
    {
      secrets: {
        resolve: async () => ({
          ALLOWED: "scoped-only",
          OTHER_EXTENSION: "must-not-leak",
        }),
      },
    },
  );
  t.after(async () => {
    host.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  assertEquals(
    await Promise.all([
      host.execute("first", "inspect", 20),
      host.execute("second", "inspect", 0),
    ]),
    [
      { id: "first", secrets: { ALLOWED: "scoped-only" } },
      { id: "second", secrets: { ALLOWED: "scoped-only" } },
    ],
  );
});

test("ExtensionHost bounds concurrent executions and releases capacity after completion", {
  timeout: 15_000,
}, async (t) => {
  const directory = await makeTempDirectory();
  const releases: ((value: JsonValue) => void)[] = [];
  let allEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    allEntered = resolve;
  });
  const base = await isolationHost(
    directory,
    'export default { actions: { inspect: context => context.host.ui.showMessage({ title: "Test", message: "Test" }) } };',
  );
  const host = await isolationHost(
    directory,
    await fs.readFile(`${directory}/extension.mjs`, "utf8"),
    [],
    [],
    {
      manifest: { ...base.manifest, capabilities: ["host.ui.message-box"] },
      grant: {
        capabilities: ["host.ui.message-box"],
        network: [],
        secrets: [],
      },
      hostCapabilities: {
        invoke: () =>
          new Promise((resolve) => {
            releases.push(resolve);
            if (releases.length === 32) allEntered();
          }),
      },
    },
  );
  t.after(async () => {
    host.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const executions = Array.from({ length: 32 }, (_, index) =>
    host.execute(`parallel-${index}`, "inspect", null, 10_000),
  );
  // Attach handlers before waiting so a failed startup cannot produce unhandled rejections.
  const completed = Promise.all(executions);
  void completed.catch(() => undefined);
  await entered;
  await assertRejects(
    () => host.execute("overflow", "inspect", null),
    Error,
    "execution limit",
  );
  releases.forEach((resolve) => resolve({ displayed: true }));
  assertEquals((await completed).length, 32);
  const next = host.execute("after-completion", "inspect", null);
  while (releases.length < 33)
    await new Promise((resolve) => setTimeout(resolve, 5));
  releases[32]!({ displayed: true });
  assertEquals(await next, { displayed: true });
});

test("ExtensionHost stops pending work and ignores a late host reply after restarting", async (t) => {
  const directory = await makeTempDirectory();
  let release!: (value: JsonValue) => void, entered!: () => void;
  const called = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const base = await isolationHost(
    directory,
    'export default { actions: { inspect: (context, input) => input ? context.host.ui.showMessage({ title: "Test", message: "Test" }) : "fresh" } };',
  );
  const host = await isolationHost(
    directory,
    await fs.readFile(`${directory}/extension.mjs`, "utf8"),
    [],
    [],
    {
      manifest: { ...base.manifest, capabilities: ["host.ui.message-box"] },
      grant: {
        capabilities: ["host.ui.message-box"],
        network: [],
        secrets: [],
      },
      hostCapabilities: {
        invoke: () =>
          new Promise((resolve) => {
            release = resolve;
            entered();
          }),
      },
    },
  );
  t.after(async () => {
    host.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const pending = assertRejects(
    () => host.execute("stopped", "inspect", true),
    Error,
    "process stopped",
  );
  await called;
  host.stop();
  await pending;
  assertEquals(await host.execute("restarted", "inspect", false), "fresh");
  release({ displayed: true });
  assertEquals(
    await host.execute("after-late-reply", "inspect", false),
    "fresh",
  );
});

test("ExtensionHost enforces network grants independently across simultaneous sandboxes and redirects", async (t) => {
  let protectedRequests = 0;
  const protectedServer = createServer((_request, response) => {
    protectedRequests++;
    response.end("scoped target");
  });
  const redirectServer = createServer((_request, response) => {
    response.writeHead(302, {
      location: `http://127.0.0.1:${(protectedServer.address() as AddressInfo).port}/`,
    });
    response.end();
  });
  await Promise.all([
    new Promise<void>((resolve) =>
      protectedServer.listen(0, "127.0.0.1", resolve),
    ),
    new Promise<void>((resolve) =>
      redirectServer.listen(0, "127.0.0.1", resolve),
    ),
  ]);
  const protectedPort = (protectedServer.address() as AddressInfo).port,
    redirectPort = (redirectServer.address() as AddressInfo).port;
  const firstDirectory = await makeTempDirectory(),
    secondDirectory = await makeTempDirectory();
  const source =
    "export default { actions: { inspect: async (_context, input) => { try { const response = await fetch(input); await response.body?.cancel(); return response.ok; } catch { return false; } } } };";
  const first = await isolationHost(firstDirectory, source, [
    `127.0.0.1:${protectedPort}`,
  ]);
  const second = await isolationHost(secondDirectory, source, [
    `127.0.0.1:${redirectPort}`,
  ]);
  t.after(async () => {
    first.stop();
    second.stop();
    protectedServer.closeAllConnections();
    redirectServer.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => protectedServer.close(() => resolve())),
      new Promise<void>((resolve) => redirectServer.close(() => resolve())),
    ]);
    await Promise.all([
      fs.rm(firstDirectory, { recursive: true, force: true }),
      fs.rm(secondDirectory, { recursive: true, force: true }),
    ]);
  });
  assertEquals(
    await Promise.all([
      first.execute("allowed", "inspect", `http://127.0.0.1:${protectedPort}/`),
      second.execute(
        "redirect",
        "inspect",
        `http://127.0.0.1:${redirectPort}/`,
      ),
    ]),
    [true, false],
  );
  assertEquals(protectedRequests, 1);
});

test("ExtensionHost caps host calls per execution before invoking more privileged side effects", async (t) => {
  const directory = await makeTempDirectory();
  let invocations = 0;
  const source =
    'export default { actions: { inspect: async context => { const replies = await Promise.allSettled(Array.from({ length: 40 }, () => context.host.ui.showMessage({ title: "Test", message: "Test" }))); return { fulfilled: replies.filter(reply => reply.status === "fulfilled").length, denied: replies.filter(reply => reply.status === "rejected").map(reply => reply.reason.message) }; } } };';
  const base = await isolationHost(directory, source);
  const host = await isolationHost(directory, source, [], [], {
    manifest: { ...base.manifest, capabilities: ["host.ui.message-box"] },
    grant: { capabilities: ["host.ui.message-box"], network: [], secrets: [] },
    hostCapabilities: {
      invoke: async () => {
        invocations++;
        return { displayed: true };
      },
    },
  });
  t.after(async () => {
    host.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const output = (await host.execute("bounded", "inspect", null)) as {
    fulfilled: number;
    denied: string[];
  };
  assertEquals(output.fulfilled, 32);
  assertEquals(invocations, 32);
  assertEquals(output.denied.length, 8);
  assertEquals(
    output.denied.every((message) => message.includes("HOST_CAPABILITY_LIMIT")),
    true,
  );
});

for (const frame of [
  "{",
  '{"type":"unknown"}',
  '{"type":"result","executionId":42,"output":"forged"}',
]) {
  test(`ExtensionHost fails closed for guest-written protocol data and recovers: ${frame}`, async (t) => {
    const directory = await makeTempDirectory();
    const source = `import { writeSync } from "node:fs"; export default { actions: { inspect: (_context, input) => { if (input) writeSync(process.platform === "win32" ? 1 : 3, ${JSON.stringify(`${frame}\n`)}); return "healthy"; } } };`;
    const host = await isolationHost(directory, source);
    t.after(async () => {
      host.stop();
      await fs.rm(directory, { recursive: true, force: true });
    });
    await assertRejects(() => host.execute("forged", "inspect", true));
    assertEquals(await host.execute("recovered", "inspect", false), "healthy");
  });
}

test("ExtensionHost bounds request and result frames and allows a fresh valid execution", async (t) => {
  const directory = await makeTempDirectory();
  const host = await isolationHost(
    directory,
    'export default { actions: { inspect: (_context, input) => input === true ? "x".repeat(17 * 1024 * 1024) : "healthy" } };',
  );
  t.after(async () => {
    host.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await assertRejects(
    () =>
      host.execute(
        "oversized-request",
        "inspect",
        "x".repeat(17 * 1024 * 1024),
      ),
    Error,
    "protocol limit",
  );
  assertEquals(
    await host.execute("after-request", "inspect", false),
    "healthy",
  );
  await assertRejects(
    () => host.execute("oversized-result", "inspect", true),
    Error,
    "Extension action failed",
  );
  assertEquals(await host.execute("after-result", "inspect", false), "healthy");
});

test("ExtensionHost terminates hung initialization and can restart after a corrected immutable candidate", async (t) => {
  const directory = await makeTempDirectory();
  const host = await isolationHost(
    directory,
    'await new Promise(() => {}); export default { actions: { inspect: () => "healthy" } };',
    [],
    [],
    { startupTimeoutMs: process.platform === "win32" ? 10_000 : 2_000 },
  );
  t.after(async () => {
    host.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await assertRejects(() => host.start(), Error, "did not become ready");
  await fs.writeFile(
    `${directory}/extension.mjs`,
    'export default { actions: { inspect: () => "healthy" } };',
  );
  assertEquals(
    await host.execute("after-startup-timeout", "inspect", null),
    "healthy",
  );
});

test("ExtensionHost rejects outputs violating the signed schema without coercion and remains usable", async (t) => {
  const directory = await makeTempDirectory();
  const source =
    'export default { actions: { inspect: (_context, input) => ({ count: input ? "1" : 1 }) } };';
  const base = await isolationHost(directory, source);
  await fs.writeFile(
    `${directory}/output.json`,
    JSON.stringify({
      type: "object",
      required: ["count"],
      additionalProperties: false,
      properties: { count: { type: "integer" } },
    }),
  );
  const host = await isolationHost(directory, source, [], [], {
    manifest: {
      ...base.manifest,
      actions: [{ ...base.manifest.actions[0]!, outputSchema: "output.json" }],
    },
  });
  t.after(async () => {
    host.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await assertRejects(
    () => host.execute("invalid-output", "inspect", true),
    Error,
    "output violates its contract",
  );
  assertEquals(await host.execute("valid-output", "inspect", false), {
    count: 1,
  });
});
