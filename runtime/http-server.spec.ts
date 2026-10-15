import { test } from "node:test";
import { once } from "node:events";
import { WebSocket } from "ws";
import { assertEquals } from "../test/assert.ts";
import { serveHttp } from "./http-server.ts";

test("Node listener preserves Fetch requests, WebSocket frames and abort shutdown", async () => {
  const abort = new AbortController();
  const server = await serveHttp(
    { hostname: "127.0.0.1", port: 0, signal: abort.signal },
    async (request) =>
      new Response(
        JSON.stringify({
          authorization: request.headers.get("authorization"),
          body: await request.text(),
        }),
        { status: 201 },
      ),
    (socket) => {
      socket.on("message", (data) => socket.send(data.toString()));
    },
  );
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const opened = once(socket, "open");
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/request`, {
      method: "POST",
      headers: { authorization: "Bearer local-test" },
      body: "payload",
    });
    assertEquals(response.status, 201);
    assertEquals(await response.json(), {
      authorization: "Bearer local-test",
      body: "payload",
    });
    await opened;
    const reply = once(socket, "message");
    socket.send("connector-frame");
    assertEquals((await reply)[0].toString(), "connector-frame");
    const closed = once(socket, "close");
    abort.abort();
    await Promise.all([closed, server.finished]);
  } finally {
    socket.terminate();
    abort.abort();
  }
});

test("Node listener transports binary WebSocket frames without text conversion", async () => {
  const abort = new AbortController();
  const server = await serveHttp(
    { hostname: "127.0.0.1", port: 0, signal: abort.signal },
    () => new Response("ok"),
    (socket) => {
      socket.on("error", () => undefined);
      socket.on("message", (bytes, binary) => socket.send(bytes, { binary }));
    },
  );
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  try {
    await once(socket, "open");
    const reply = once(socket, "message");
    socket.send(Buffer.from([0, 255, 128, 10]));
    const [bytes, binary] = await reply;
    assertEquals(binary, true);
    assertEquals(bytes, Buffer.from([0, 255, 128, 10]));
  } finally {
    socket.terminate();
    abort.abort();
    await server.finished;
  }
});
test("Node listener rejects WebSocket upgrades outside the protocol route", async () => {
  const abort = new AbortController();
  let upgrades = 0;
  const server = await serveHttp(
    { hostname: "127.0.0.1", port: 0, signal: abort.signal },
    () => new Response("ok"),
    () => {
      upgrades++;
    },
  );
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/admin`);
  socket.on("error", () => undefined);
  try {
    const [_request, response] = await once(socket, "unexpected-response");
    assertEquals(response.statusCode, 404);
    response.resume();
    assertEquals(upgrades, 0);
  } finally {
    socket.terminate();
    abort.abort();
    await server.finished;
  }
});
test("Node listener closes on an already aborted signal and supports repeated shutdown", async () => {
  const abort = new AbortController();
  abort.abort();
  const server = await serveHttp(
    { hostname: "127.0.0.1", port: 0, signal: abort.signal },
    () => new Response("ok"),
    () => undefined,
  );
  await server.finished;
  await Promise.all([server.shutdown(), server.shutdown()]);
});
