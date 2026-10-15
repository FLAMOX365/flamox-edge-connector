import { test } from "node:test";
import { makeTempDirectory } from "./files.ts";
import * as fs from "node:fs/promises";
import { assert, assertEquals } from "../test/assert.ts";
import { dirname, join } from "node:path";
import { HttpFunctionRouter } from "./function-router.ts";
import { HttpFunctionScanner } from "./function-scanner.ts";
import type { EdgeConnectorRequestFrame } from "./generated/models.ts";
import { createLogger } from "./logger.ts";
import { RuntimeError } from "./runtime-error.ts";

const silentLogger = createLogger("error", {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
});

test("HttpFunctionRouter executes matched handlers with params, query, headers, body, and env", async () => {
  await usingTempDir(async (dir) => {
    await writeTextFile(
      join(dir, "users", "[id].ts"),
      `
export async function GET(ctx) {
    return ctx.res.ok().json({
        id: ctx.req.params.require("id"),
        expand: ctx.req.query.get("expand"),
        tenant: ctx.env.TENANT,
        header: ctx.req.headers.get("x-test"),
    });
}

export async function POST(ctx) {
    const body = await ctx.req.body.json();
    return ctx.res.created().header("x-created", "yes").json({ body });
}
`,
    );
    const router = await createRouter(dir, { TENANT: "tenant-1" });

    const getResponse = await router.execute(
      createFrame("GET", "/users/42?expand=roles", {
        "x-test": ["header-value"],
      }),
    );
    const postResponse = await router.execute(
      createFrame(
        "POST",
        "/users/42",
        {
          "content-type": ["application/json"],
        },
        '{"name":"Ada"}',
      ),
    );

    assertEquals(getResponse.statusCode, 200);
    assertEquals(JSON.parse(getResponse.body ?? "{}"), {
      id: "42",
      expand: "roles",
      tenant: "tenant-1",
      header: "header-value",
    });
    assertEquals(postResponse.statusCode, 201);
    assertEquals(postResponse.headers?.["x-created"], ["yes"]);
    assertEquals(JSON.parse(postResponse.body ?? "{}"), {
      body: { name: "Ada" },
    });
  });
});

test("HttpFunctionRouter reports method and route mismatches", async () => {
  await usingTempDir(async (dir) => {
    await writeTextFile(
      join(dir, "users", "[id].ts"),
      `
export function GET() {
    return new Response("ok");
}
`,
    );
    const router = await createRouter(dir, {});

    await assertRuntimeError(
      () => router.execute(createFrame("DELETE", "/users/42")),
      "METHOD_NOT_ALLOWED",
    );
    await assertRuntimeError(
      () => router.execute(createFrame("GET", "/projects/42")),
      "NOT_FOUND",
    );
  });
});

async function createRouter(
  dir: string,
  env: Record<string, string>,
): Promise<HttpFunctionRouter> {
  const scanner = new HttpFunctionScanner({ logger: silentLogger, env });
  await scanner.scan(dir);
  return new HttpFunctionRouter({ scanner, env, logger: silentLogger });
}

function createFrame(
  method: EdgeConnectorRequestFrame["request"]["method"],
  url: string,
  headers?: Record<string, string[]>,
  body?: string,
): EdgeConnectorRequestFrame {
  return {
    type: "request",
    requestId: "request-1",
    request: { method, url, headers, body },
  };
}

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

async function assertRuntimeError(
  action: () => Promise<unknown>,
  code: string,
): Promise<RuntimeError> {
  try {
    await action();
  } catch (error) {
    assert(error instanceof RuntimeError);
    assertEquals(error.code, code);
    return error;
  }

  throw new Error(`Expected RuntimeError with code ${code}`);
}
