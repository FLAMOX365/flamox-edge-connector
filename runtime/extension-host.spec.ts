import { test } from "node:test";
import { makeTempDirectory } from "./files.ts";
import * as fs from "node:fs/promises";
import { assertEquals, assertRejects } from "../test/assert.ts";
import type { JsonValue } from "@edge-connector/sdk/extension";
import { parseExtensionManifest } from "./extension-manifest.ts";
import { ExtensionHost } from "./extension-host.ts";
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
