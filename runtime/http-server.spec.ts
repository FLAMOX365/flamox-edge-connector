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
