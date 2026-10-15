import { test } from "node:test";
import { assertEquals } from "../test/assert.ts";
import { checkHealth, readHealthPort } from "./health-check.ts";

test("readHealthPort uses the default connector port", () => {
  assertEquals(readHealthPort(undefined), 8080);
  assertEquals(readHealthPort("9090"), 9090);
});

test("checkHealth returns success for healthy responses", async () => {
  const exitCode = await checkHealth(9090, (input) => {
    assertEquals(input, "http://localhost:9090/health");
    return Promise.resolve(new Response("ok", { status: 200 }));
  });

  assertEquals(exitCode, 0);
});

test("checkHealth returns failure for unhealthy responses and fetch errors", async () => {
  assertEquals(
    await checkHealth(9090, () =>
      Promise.resolve(new Response("down", { status: 503 })),
    ),
    1,
  );
  assertEquals(
    await checkHealth(9090, () => Promise.reject(new Error("offline"))),
    1,
  );
});
