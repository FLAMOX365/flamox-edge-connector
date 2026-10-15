import type { WebSocket } from "ws";
import { test } from "node:test";
import { assertEquals } from "../test/assert.ts";
import { ConnectorRuntime, type ProtocolExecutor } from "./connector.ts";
import type { EdgeConnectorMessageFrame } from "./generated/models.ts";
import { createLogger } from "./logger.ts";
import type { WritableFrame } from "./protocol.ts";

const silentLogger = createLogger("error", {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
});

test("ConnectorRuntime ignores unsupported inbound response frames", async () => {
  const warnings: string[] = [];
  const runtime = createRuntime({
    warn: (...data: unknown[]) => {
      warnings.push(String(data[0]));
    },
  });
  const sentFrames: WritableFrame[] = [];

  await runtime.handleFrame(
    {
      type: "response",
      requestId: "00000000-0000-4000-8000-000000000001",
    } as EdgeConnectorMessageFrame,
    (frame) => {
      sentFrames.push(frame);
    },
  );

  assertEquals(sentFrames, []);
  assertEquals(warnings, ["Ignoring unsupported inbound frame type: response"]);
});

test("ConnectorRuntime executes protocol executor for request frames", async () => {
  const sentFrames: WritableFrame[] = [];
  const protocolExecutor = {
    execute: () =>
      Promise.resolve({
        statusCode: 207,
        headers: { "x-mode": ["function"] },
        body: "function-response",
      }),
  } as unknown as ProtocolExecutor;
  const runtime = new ConnectorRuntime({
    protocolExecutor,
    logger: silentLogger,
  });

  await runtime.handleFrame(
    {
      type: "request",
      requestId: "00000000-0000-4000-8000-000000000001",
      request: { method: "GET", url: "/users" },
    },
    (frame) => {
      sentFrames.push(frame);
    },
  );

  assertEquals(sentFrames, [
    {
      type: "response",
      requestId: "00000000-0000-4000-8000-000000000001",
      response: {
        statusCode: 207,
        headers: { "x-mode": ["function"] },
        body: "function-response",
      },
    },
  ]);
});

test("ConnectorRuntime attaches to WebSocket messages and serializes responses", async () => {
  const socket = new FakeSocket();
  const runtime = createRuntime();

  runtime.attachWebSocket(socket as unknown as WebSocket);
  socket.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({
        type: "request",
        requestId: "00000000-0000-4000-8000-000000000001",
        request: { method: "GET", url: "/users" },
      }),
    }),
  );
  await nextTick();

  assertEquals(
    socket.sent.map((frame) => JSON.parse(frame)),
    [
      {
        type: "response",
        requestId: "00000000-0000-4000-8000-000000000001",
        response: { statusCode: 204 },
      },
    ],
  );
});

function createRuntime(
  logger?: Partial<typeof silentLogger>,
): ConnectorRuntime {
  return new ConnectorRuntime({
    protocolExecutor: {
      execute: () => Promise.resolve({ statusCode: 204 }),
    } as unknown as ProtocolExecutor,
    logger: { ...silentLogger, ...logger },
  });
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeSocket extends EventTarget {
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }
}
