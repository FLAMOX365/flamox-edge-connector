import { test } from "node:test";
import { assertEquals, assertRejects } from "../test/assert.ts";
import type { EdgeConnectorRequestFrame } from "./generated/models.ts";
import { createLogger } from "./logger.ts";
import { HttpProxyExecutor } from "./proxy-router.ts";
import { RuntimeError } from "./runtime-error.ts";

const silentLogger = createLogger("error", {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
});

test("HttpProxyExecutor forwards the request to its absolute URL and maps the response", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; init?: RequestInit } | undefined;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: string | URL | Request, init?: RequestInit) => {
      captured = { url: input.toString(), init };
      return Promise.resolve(
        new Response("pong", {
          status: 201,
          headers: { "x-upstream": "yes" },
        }),
      );
    },
  });

  try {
    const router = new HttpProxyExecutor({ logger: silentLogger });
    const response = await router.execute({
      type: "request",
      requestId: "00000000-0000-0000-0000-000000000001",
      request: {
        method: "POST",
        url: "https://internal.example/orders?id=7",
        headers: {
          "content-type": ["application/json"],
          host: ["cloud"],
        },
        body: "payload",
      },
    } as EdgeConnectorRequestFrame);

    assertEquals(captured?.url, "https://internal.example/orders?id=7");
    assertEquals(captured?.init?.method, "POST");
    assertEquals(captured?.init?.body, "payload");
    const headers = captured?.init?.headers as Headers;
    assertEquals(headers.get("content-type"), "application/json");
    assertEquals(headers.get("host"), null); // host header dropped

    assertEquals(response.statusCode, 201);
    assertEquals(response.headers?.["x-upstream"], ["yes"]);
    assertEquals(response.body, "pong");
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  }
});

test("HttpProxyExecutor returns a null body for an empty upstream response", async () => {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: () => Promise.resolve(new Response(null, { status: 204 })),
  });

  try {
    const router = new HttpProxyExecutor({ logger: silentLogger });
    const response = await router.execute({
      type: "request",
      requestId: "00000000-0000-0000-0000-000000000002",
      request: { method: "GET", url: "https://internal.example/health" },
    } as EdgeConnectorRequestFrame);

    assertEquals(response.statusCode, 204);
    assertEquals(response.body, null);
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  }
});

test("HttpProxyExecutor rejects a relative request URL with a clear error", async () => {
  const router = new HttpProxyExecutor({ logger: silentLogger });
  await assertRejects(
    () =>
      router.execute({
        type: "request",
        requestId: "00000000-0000-0000-0000-000000000003",
        request: { method: "GET", url: "/orders" },
      } as EdgeConnectorRequestFrame),
    RuntimeError,
    "Proxy mode requires an absolute request URL",
  );
});
