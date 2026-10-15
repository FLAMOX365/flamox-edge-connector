import { test } from "node:test";
import { makeTempDirectory } from "./files.ts";
import * as fs from "node:fs/promises";
import { assert, assertEquals } from "../test/assert.ts";
import { dirname, join } from "node:path";
import { HttpFunctionScanner } from "./function-scanner.ts";
import { createLogger } from "./logger.ts";

const silentLogger = createLogger("error", {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
});

test("HttpFunctionScanner registers TypeScript routes with dynamic and catch-all segments", async () => {
  await usingTempDir(async (dir) => {
    const sdkUrl = new URL("../sdk/mod.ts", import.meta.url).href;
    await writeTextFile(
      join(dir, "health.ts"),
      `
export function GET() {
    return new Response("healthy");
}
`,
    );
    await writeTextFile(
      join(dir, "users", "index.ts"),
      `
  import { defineHttp } from "${sdkUrl}";

  export default defineHttp({
    get: () => new Response("users"),
    post: () => new Response("created", { status: 201 }),
  });
`,
    );
    await writeTextFile(
      join(dir, "users", "[id].ts"),
      `
export function GET(ctx) {
  return new Response(ctx.req.params.require("id"));
}
`,
    );
    await writeTextFile(
      join(dir, "files", "[...path].ts"),
      `
export function GET(ctx) {
  return new Response(ctx.req.params.require("path"));
}
`,
    );
    await writeTextFile(join(dir, "_shared.ts"), "export function GET() {}\n");
    await writeTextFile(
      join(dir, "debug.spec.ts"),
      "export function GET() {}\n",
    );
    const scanner = new HttpFunctionScanner({ logger: silentLogger });

    await scanner.scan(dir);

    assertEquals(scanner.routeCount, 4);
    assertEquals(scanner.getAllowedMethods("/users"), ["GET", "POST"]);
    assertEquals(scanner.hasRoute("/users/42"), true);
    assertEquals(
      scanner.match(new Request("http://localhost/users/42"))?.params,
      { id: "42" },
    );
    assertEquals(
      scanner.match(new Request("http://localhost/files/a/b.txt"))?.params,
      { path: "a/b.txt" },
    );
    assertEquals(scanner.match(new Request("http://localhost/_shared")), null);
    assertEquals(
      scanner.match(new Request("http://localhost/debug.spec")),
      null,
    );
  });
});

test("HttpFunctionScanner registers YAML functions and filters unsupported methods", async () => {
  await usingTempDir(async (dir) => {
    await writeTextFile(
      join(dir, "tickets", "index.yml"),
      `
target: "https://tickets.example/api/"
methods: [GET, post, TRACE]
`,
    );
    const scanner = new HttpFunctionScanner({ logger: silentLogger });

    await scanner.scan(dir);

    assertEquals(scanner.routeCount, 1);
    assertEquals(scanner.getAllowedMethods("/tickets"), ["GET", "POST"]);
    assertEquals(
      scanner.match(new Request("http://localhost/tickets"))?.route.path,
      "/tickets",
    );
    assertEquals(
      scanner.match(
        new Request("http://localhost/tickets", { method: "DELETE" }),
      ),
      null,
    );
  });
});

test("HttpFunctionScanner treats root index handlers as catch-all routes", async () => {
  await usingTempDir(async (dir) => {
    const sdkUrl = new URL("../sdk/mod.ts", import.meta.url).href;
    await writeTextFile(
      join(dir, "index.ts"),
      `
import { http } from "${sdkUrl}";

export default http().get((ctx) => new Response(ctx.req.path));
`,
    );
    await writeTextFile(
      join(dir, "health.ts"),
      `
export function GET() {
    return new Response("healthy");
}
`,
    );
    const scanner = new HttpFunctionScanner({ logger: silentLogger });

    await scanner.scan(dir);

    assertEquals(scanner.routeCount, 2);
    assertEquals(
      scanner.match(new Request("http://localhost/"))?.route.path,
      "/",
    );
    assertEquals(
      scanner.match(new Request("http://localhost/orders/42"))?.route.path,
      "/",
    );
    assertEquals(
      scanner.match(new Request("http://localhost/health"))?.route.path,
      "/health",
    );
    assertEquals(scanner.getAllowedMethods("/orders/42"), ["GET"]);
  });
});

test("HttpFunctionScanner replaces stale routes on rescan", async () => {
  await usingTempDir(async (dir) => {
    await writeTextFile(
      join(dir, "health.ts"),
      "export function GET() { return new Response('ok'); }\n",
    );
    const scanner = new HttpFunctionScanner({ logger: silentLogger });

    await scanner.scan(dir);
    assertEquals(scanner.routeCount, 1);

    await fs.rm(join(dir, "health.ts"));
    await scanner.scan(dir);

    assertEquals(scanner.routeCount, 0);
    assertEquals(scanner.match(new Request("http://localhost/health")), null);
  });
});

test("HttpFunctionScanner skips YAML functions without target", async () => {
  await usingTempDir(async (dir) => {
    await writeTextFile(join(dir, "broken.yml"), "methods: [GET]\n");
    const errors: string[] = [];
    const scanner = new HttpFunctionScanner({
      logger: {
        ...silentLogger,
        error: (...data: unknown[]) => {
          errors.push(String(data[0]));
        },
      },
    });

    await scanner.scan(dir);

    assertEquals(scanner.routeCount, 0);
    assert(
      errors.some((message) =>
        message.includes("missing required 'target' field"),
      ),
    );
  });
});

test("HttpFunctionScanner treats missing function directories as empty", async () => {
  const scanner = new HttpFunctionScanner({ logger: silentLogger });

  await scanner.scan("/path/that/does/not/exist");

  assertEquals(scanner.routeCount, 0);
});

test("HttpFunctionScanner isolates faulty modules and continues loading other functions", async () => {
  await usingTempDir(async (dir) => {
    const sdkUrl = new URL("../sdk/mod.ts", import.meta.url).href;

    // Valid function
    await writeTextFile(
      join(dir, "health.ts"),
      `
export function GET() {
    return new Response("healthy");
}
`,
    );

    // Faulty function with duplicate handler registration
    await writeTextFile(
      join(dir, "broken.ts"),
      `
import { http } from "${sdkUrl}";

// This will throw DUPLICATE_HANDLER at module load time
export default (http() as any).get(() => new Response("first")).get(() => new Response("second"));
`,
    );

    // Another valid function
    await writeTextFile(
      join(dir, "users.ts"),
      `
export function GET() {
    return new Response("users");
}
`,
    );

    const errorMessages: string[] = [];
    const testLogger = createLogger("error", {
      debug: () => undefined,
      error: (...args: unknown[]) => errorMessages.push(args.join(" ")),
      info: () => undefined,
      warn: () => undefined,
    });
    const scanner = new HttpFunctionScanner({ logger: testLogger });

    await scanner.scan(dir);

    // Should have loaded the 2 valid functions, skipping the broken one
    assertEquals(scanner.routeCount, 2);
    assertEquals(scanner.hasRoute("/health"), true);
    assertEquals(scanner.hasRoute("/users"), true);
    assertEquals(scanner.hasRoute("/broken"), false);

    // Should have logged an error for the broken function
    const allErrors = errorMessages.join("\n");
    assert(
      allErrors.includes("broken.ts"),
      `Expected error for broken.ts, got: ${allErrors}`,
    );
    assert(
      allErrors.includes("DUPLICATE_HANDLER") ||
        allErrors.includes("already registered"),
      `Expected DUPLICATE_HANDLER error, got: ${allErrors}`,
    );
  });
});

test("HttpFunctionScanner isolates JavaScript files with syntax errors", async () => {
  await usingTempDir(async (dir) => {
    // Valid function
    await writeTextFile(
      join(dir, "health.ts"),
      `
export function GET() {
    return new Response("healthy");
}
`,
    );

    // JavaScript file with syntax error
    await writeTextFile(
      join(dir, "corrupt.js"),
      `
export function GET() {
    return new Response("this has a syntax error"
    // Missing closing parenthesis and brace
`,
    );

    // Another valid function
    await writeTextFile(
      join(dir, "status.ts"),
      `
export function GET() {
    return new Response("status ok");
}
`,
    );

    const errorMessages: string[] = [];
    const testLogger = createLogger("error", {
      debug: () => undefined,
      error: (...args: unknown[]) => errorMessages.push(args.join(" ")),
      info: () => undefined,
      warn: () => undefined,
    });
    const scanner = new HttpFunctionScanner({ logger: testLogger });

    await scanner.scan(dir);

    // Should have loaded the 2 valid functions
    assertEquals(scanner.routeCount, 2);
    assertEquals(scanner.hasRoute("/health"), true);
    assertEquals(scanner.hasRoute("/status"), true);
    assertEquals(scanner.hasRoute("/corrupt"), false);

    // Should have logged an error for the corrupt file
    const allErrors = errorMessages.join("\n");
    assert(
      allErrors.includes("corrupt.js"),
      `Expected error for corrupt.js, got: ${allErrors}`,
    );
  });
});

test("HttpFunctionScanner skips modules with non-route default exports", async () => {
  await usingTempDir(async (dir) => {
    // Valid function
    await writeTextFile(
      join(dir, "health.ts"),
      `
export function GET() {
    return new Response("healthy");
}
`,
    );

    // Module that exports a string instead of a route definition
    await writeTextFile(
      join(dir, "invalid-export.ts"),
      `
export default "I am not a route definition";
`,
    );

    // Module that exports an object that looks like a route but isn't
    await writeTextFile(
      join(dir, "fake-route.ts"),
      `
export default {
    protocol: "ftp",  // Wrong protocol
    handlers: {}
};
`,
    );

    const warnMessages: string[] = [];
    const testLogger = createLogger("info", {
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: (...args: unknown[]) => warnMessages.push(args.join(" ")),
    });
    const scanner = new HttpFunctionScanner({ logger: testLogger });

    await scanner.scan(dir);

    // Should only load the valid health function
    assertEquals(scanner.routeCount, 1);
    assertEquals(scanner.hasRoute("/health"), true);
    assertEquals(scanner.hasRoute("/invalid-export"), false);
    assertEquals(scanner.hasRoute("/fake-route"), false);
  });
});

test("HttpFunctionScanner handles modules with only named exports", async () => {
  await usingTempDir(async (dir) => {
    // Module with only named exports (no default)
    await writeTextFile(
      join(dir, "api.ts"),
      `
export function GET() {
    return new Response("get");
}

export function POST() {
    return new Response("post");
}

export function DELETE() {
    return new Response("delete");
}

// Non-handler exports should be ignored
export const config = { timeout: 5000 };
export function helperFunction() {}
`,
    );

    const scanner = new HttpFunctionScanner({ logger: silentLogger });
    await scanner.scan(dir);

    assertEquals(scanner.routeCount, 1);
    assertEquals(scanner.getAllowedMethods("/api"), ["GET", "POST", "DELETE"]);
  });
});

async function usingTempDir(
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await makeTempDirectory();
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
}

async function writeTextFile(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content.trimStart());
}
