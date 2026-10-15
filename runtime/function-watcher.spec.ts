import * as fs from "node:fs/promises";
import { makeTempDirectory } from "./files.ts";
import { watchFunctionsDirectory } from "./function-watcher.ts";
import { createLogger } from "./logger.ts";
import { HttpFunctionScanner } from "./function-scanner.ts";
import { test } from "node:test";
import { assertEquals } from "../test/assert.ts";
import { join } from "node:path";
import { isFunctionsPath } from "./function-watcher.ts";

test("isFunctionsPath matches the functions directory and nested files only", () => {
  const root = join(process.cwd(), "functions");

  assertEquals(isFunctionsPath(root, root), true);
  assertEquals(isFunctionsPath(root, join(root, "index.ts")), true);
  assertEquals(isFunctionsPath(root, join(root, "users", "index.yml")), true);
  assertEquals(
    isFunctionsPath(root, join(process.cwd(), "functionality.ts")),
    false,
  );
});

test("Node watcher discovers a newly created functions directory, reloads nested files and closes on abort", {
  timeout: 5_000,
}, async (t) => {
  const root = await makeTempDirectory("edge-watch-");
  const functions = join(root, "functions");
  const abort = new AbortController();
  const snapshots: string[][] = [];
  let watching!: () => void;
  const ready = new Promise<void>((resolve) => {
    watching = resolve;
  });
  let changed!: () => void;
  let change = new Promise<void>((resolve) => {
    changed = resolve;
  });
  const finished = watchFunctionsDirectory({
    functionsDir: functions,
    signal: abort.signal,
    debounceMs: 5,
    logger: createLogger("info", {
      info: () => watching(),
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    }),
    reload: async () => {
      snapshots.push(await fs.readdir(functions, { recursive: true }));
      changed();
    },
  });
  t.after(async () => {
    abort.abort();
    await finished;
    await fs.rm(root, { recursive: true, force: true });
  });
  await ready;
  await fs.writeFile(join(root, "unrelated.txt"), "ignore");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals(snapshots.length, 0);
  await fs.mkdir(join(functions, "nested"), { recursive: true });
  await fs.writeFile(
    join(functions, "nested", "index.ts"),
    "export function GET() { return new Response('ready'); }",
  );
  while (
    !snapshots.some((files) => files.includes(join("nested", "index.ts")))
  ) {
    await change;
    change = new Promise<void>((resolve) => {
      changed = resolve;
    });
  }
  abort.abort();
  await finished;
  const count = snapshots.length;
  await fs.writeFile(
    join(functions, "after-stop.ts"),
    "export function GET() {}",
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assertEquals(snapshots.length, count);
});

test("Node watcher reloads changed TypeScript behavior and removes deleted routes", {
  timeout: 15_000,
}, async (t) => {
  const directory = await makeTempDirectory("edge-watch-routes-");
  const path = join(directory, "health.ts");
  const abort = new AbortController();
  const scanner = new HttpFunctionScanner({ logger: silentLogger });
  let ready!: () => void;
  const watching = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let expected: { value: string | null; resolve(): void } | undefined;
  const observations: (string | null)[] = [];
  const next = (value: string | null) =>
    new Promise<void>((resolve) => {
      expected = { value, resolve };
    });
  const finished = watchFunctionsDirectory({
    functionsDir: directory,
    signal: abort.signal,
    debounceMs: 30,
    logger: createLogger("info", { ...silentLogger, info: () => ready() }),
    reload: async () => {
      await scanner.scan(directory);
      const matched = scanner.match(new Request("http://localhost/health"));
      const body = matched
        ? await (await matched.handler({} as never)).text()
        : null;
      observations.push(body);
      if (expected?.value === body) expected.resolve();
    },
  });
  t.after(async () => {
    if (t.signal.aborted)
      t.diagnostic(JSON.stringify({ observations, expected: expected?.value }));
    abort.abort();
    await finished;
    await fs.rm(directory, { recursive: true, force: true });
  });
  await watching;
  const created = next("first");
  await fs.writeFile(
    path,
    "export function GET() { return new Response('first'); }",
  );
  await created;
  assertEquals(scanner.hasRoute("/health"), true);
  const updated = next("updated");
  await fs.writeFile(
    path,
    "export function GET() { return new Response('updated'); }",
  );
  await updated;
  const removed = next(null);
  await fs.rm(path);
  await removed;
  assertEquals(scanner.routeCount, 0);
});

const silentLogger = createLogger("error", {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
});
