import { test } from "node:test";
import assert from "node:assert/strict";
import { connectTcp } from "./tcp.ts";

test("TCP adapter fails closed when its authenticated sandbox proxy is missing or malformed", async (t) => {
  const original = process.env.ALL_PROXY,
    lower = process.env.all_proxy;
  t.after(() => {
    if (original === undefined) delete process.env.ALL_PROXY;
    else process.env.ALL_PROXY = original;
    if (lower === undefined) delete process.env.all_proxy;
    else process.env.all_proxy = lower;
  });
  delete process.env.ALL_PROXY;
  delete process.env.all_proxy;
  await assert.rejects(
    () => connectTcp("127.0.0.1", 1433),
    /proxy is unavailable/,
  );
  for (const proxy of [
    "http://127.0.0.1:1080",
    "socks5://user@127.0.0.1:1080",
    "https://user:secret@127.0.0.1:1080",
    "not-a-proxy",
  ]) {
    process.env.ALL_PROXY = proxy;
    await assert.rejects(() => connectTcp("127.0.0.1", 1433));
  }
});
test("TCP adapter rejects invalid destinations before attempting a proxy connection", async () => {
  for (const [host, port] of [
    ["", 1433],
    ["bad\0host", 1433],
    ["localhost", 0],
    ["localhost", 65536],
    ["localhost", 1433.5],
  ] as const) {
    await assert.rejects(
      () => connectTcp(host, port),
      /Invalid TCP destination/,
    );
  }
});
