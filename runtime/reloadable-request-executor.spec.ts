import { test } from "node:test";
import { makeTempDirectory } from "./files.ts";
import * as fs from "node:fs/promises";
import { assertEquals } from "../test/assert.ts";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { createReloadableProtocolExecutor } from "./reloadable-request-executor.ts";

const silentLogger = createLogger("error", {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
});

test("ReloadableProtocolExecutor switches between HTTP proxy and function mode", async () => {
  const dir = await makeTempDirectory();
  try {
    const functionsDir = join(dir, "functions");
    const executor = await createReloadableProtocolExecutor({
      config: loadConfig({ EDGE_CONNECTOR_FUNCTIONS_DIR: functionsDir }),
      logger: silentLogger,
    });

    assertEquals(executor.mode, "http-proxy");
    assertEquals(executor.routes.length, 0);

    await fs.mkdir(functionsDir, { recursive: true });
    await fs.writeFile(
      join(functionsDir, "health.ts"),
      "export const GET = () => new Response('ok');\n",
    );
    await executor.reload("test create");

    assertEquals(executor.mode, "http-functions");
    assertEquals(
      executor.routes.map((route) => route.path),
      ["/health"],
    );

    await fs.rm(functionsDir, { recursive: true });
    await executor.reload("test remove");

    assertEquals(executor.mode, "http-proxy");
    assertEquals(executor.routes.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test("Integration: Starter template loads valid functions and isolates corrupt ones", async () => {
  const starterFunctionsDir = new URL(
    "../templates/starter/functions",
    import.meta.url,
  ).pathname;

  // Capture all log messages
  const logs: { level: string; message: string }[] = [];
  const capturingLogger = createLogger("debug", {
    debug: (...args: unknown[]) =>
      logs.push({ level: "debug", message: args.join(" ") }),
    info: (...args: unknown[]) =>
      logs.push({ level: "info", message: args.join(" ") }),
    warn: (...args: unknown[]) =>
      logs.push({ level: "warn", message: args.join(" ") }),
    error: (...args: unknown[]) =>
      logs.push({ level: "error", message: args.join(" ") }),
  });

  const executor = await createReloadableProtocolExecutor({
    config: loadConfig({ EDGE_CONNECTOR_FUNCTIONS_DIR: starterFunctionsDir }),
    logger: capturingLogger,
  });

  // Should be in function mode with the valid routes
  assertEquals(executor.mode, "http-functions");

  // Should have loaded at least the health endpoint
  const routes = executor.routes.map((r) => r.path);
  assertEquals(
    routes.includes("/health"),
    true,
    `Expected /health in routes: ${routes.join(", ")}`,
  );

  // Should NOT have loaded the corrupt endpoint
  assertEquals(
    routes.includes("/corrupt"),
    false,
    `Corrupt endpoint should be isolated: ${routes.join(", ")}`,
  );

  // Should have logged an error for the corrupt file
  const errorLogs = logs.filter((l) => l.level === "error");
  const corruptError = errorLogs.find((l) => l.message.includes("corrupt.js"));
  assertEquals(
    corruptError !== undefined,
    true,
    `Expected error log for corrupt.js. Error logs: ${errorLogs
      .map((l) => l.message)
      .join("\n")}`,
  );

  // Error should mention DUPLICATE_HANDLER
  const hasDuplicateError = errorLogs.some(
    (l) =>
      l.message.includes("DUPLICATE_HANDLER") ||
      l.message.includes("already registered"),
  );
  assertEquals(
    hasDuplicateError,
    true,
    `Expected DUPLICATE_HANDLER in error logs. Errors: ${errorLogs
      .map((l) => l.message)
      .join("\n")}`,
  );

  // Print full log output for visibility
  console.log("\n=== INTEGRATION TEST LOG OUTPUT ===");
  for (const log of logs) {
    console.log(`[${log.level.toUpperCase().padEnd(5)}] ${log.message}`);
  }
  console.log("=== END LOG OUTPUT ===\n");
});
