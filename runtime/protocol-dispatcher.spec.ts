import { test } from "node:test";
import { assertEquals } from "../test/assert.ts";
import type { ProtocolExecutor } from "./connector.ts";
import { ExtensionProtocolExecutor } from "./extension-protocol-executor.ts";
import { ProtocolDispatcher } from "./protocol-dispatcher.ts";

test("ProtocolDispatcher adds extension routes without replacing legacy execution", async () => {
  const calls: string[] = [];
  const extensions = new ExtensionProtocolExecutor({
    execute: () => {
      calls.push("extension");
      return Promise.resolve({ source: "extension" });
    },
  });
  const legacy: ProtocolExecutor = {
    execute: () => {
      calls.push("legacy");
      return Promise.resolve({ statusCode: 204 });
    },
  };
  const dispatcher = new ProtocolDispatcher(extensions, legacy);

  const extensionResponse = await dispatcher.execute({
    type: "request",
    requestId: "00000000-0000-0000-0000-000000000001",
    request: {
      method: "POST",
      url: "/extensions/telephony.fritzbox/actions/health",
      body: "null",
    },
  });
  const legacyResponse = await dispatcher.execute({
    type: "request",
    requestId: "00000000-0000-0000-0000-000000000002",
    request: { method: "GET", url: "/legacy/health" },
  });

  assertEquals(extensionResponse.statusCode, 200);
  assertEquals(legacyResponse.statusCode, 204);
  assertEquals(calls, ["extension", "legacy"]);
});
