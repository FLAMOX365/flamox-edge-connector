import { test } from "node:test";
import { assertEquals, assertRejects } from "../test/assert.ts";
import type { JsonValue } from "@edge-connector/sdk/extension";
import { ExtensionProtocolExecutor } from "./extension-protocol-executor.ts";
import { RuntimeError } from "./runtime-error.ts";

test("ExtensionProtocolExecutor invokes only an exact extension action route", async () => {
  const calls: unknown[][] = [];
  const executor = new ExtensionProtocolExecutor({
    execute: (requestId, extensionId, action, input) => {
      calls.push([requestId, extensionId, action, input]);
      return Promise.resolve({ accepted: true } satisfies JsonValue);
    },
  });

  const response = await executor.execute({
    type: "request",
    requestId: "00000000-0000-0000-0000-000000000001",
    request: {
      method: "POST",
      url: "/extensions/telephony.fritzbox/actions/call-log.import",
      body: '{"cursor":"42"}',
    },
  });

  assertEquals(calls, [
    [
      "00000000-0000-0000-0000-000000000001",
      "telephony.fritzbox",
      "call-log.import",
      { cursor: "42" },
    ],
  ]);
  assertEquals(response.statusCode, 200);
  assertEquals(response.body, '{"accepted":true}');
});

test("ExtensionProtocolExecutor fails closed for arbitrary targets and invalid input", async () => {
  const executor = new ExtensionProtocolExecutor({
    execute: () => Promise.resolve(null),
  });
  const request = (method: "GET" | "POST", url: string, body?: string) => ({
    type: "request" as const,
    requestId: "00000000-0000-0000-0000-000000000001",
    request: { method, url, body },
  });

  await assertRejects(
    () => executor.execute(request("POST", "https://router.local/admin")),
    RuntimeError,
    "absolute paths",
  );
  await assertRejects(
    () => executor.execute(request("GET", "/extensions/x/actions/y")),
    RuntimeError,
    "only accept POST",
  );
  await assertRejects(
    () =>
      executor.execute(request("POST", "/extensions/x/actions/y", "not-json")),
    RuntimeError,
    "valid JSON",
  );
});
