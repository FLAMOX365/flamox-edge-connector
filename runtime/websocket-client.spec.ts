import { test } from "node:test";
import { assert, assertEquals } from "../test/assert.ts";
import type { ConnectorConfig } from "./config.ts";
import { ConnectorRuntime, type ProtocolExecutor } from "./connector.ts";
import { createLogger } from "./logger.ts";
import { createRuntimeStatus } from "./runtime-status.ts";
import {
  computeBackoffDelay,
  runControlPlaneWebSocketClient as runClient,
} from "./websocket-client.ts";

const baseConfig: ConnectorConfig = {
  host: "0.0.0.0",
  port: 8080,
  allowInsecureConnections: false,
  managementUrl: undefined,
  pairingCode: undefined,
  connectorDisplayName: "Edge Connector",
  managementPollIntervalMs: 5_000,
  functionsDir: "functions",
  heartbeatIntervalMs: 1,
  reconnectInitialDelayMs: 1,
  reconnectMaxDelayMs: 1,
  dataDirectory: "data",
  extensionPolicyFile: undefined,
  trustedPublishersFile: undefined,
  connectTimeoutMs: 1_000,
  reconnectStableThresholdMs: 50,
  heartbeatTimeoutFactor: 0,
  tokenFetchTimeoutMs: 1_000,
  reconnectJitterRatio: 0,
  livenessStaleMs: 60_000,
  logLevel: "error",
};

const cloudAuth = {
  websocketUrl: "wss://cloud.example/ws",
  tokenEndpoint: "https://identity.example/oauth/token",
  clientId: "client-id",
  clientSecret: "client-secret",
};

const silentLogger = createLogger("error", {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
});

test("computeBackoffDelay is deterministic with no jitter and grows then saturates", () => {
  const initial = 1_000;
  const max = 30_000;

  assertEquals(computeBackoffDelay(0, initial, max, 0), 0);
  assertEquals(computeBackoffDelay(1, initial, max, 0), 1_000);
  assertEquals(computeBackoffDelay(2, initial, max, 0), 2_000);
  assertEquals(computeBackoffDelay(3, initial, max, 0), 4_000);
  // Saturates at max and never overflows for huge attempt counts.
  assertEquals(computeBackoffDelay(100, initial, max, 0), 30_000);
  assert(Number.isFinite(computeBackoffDelay(1_000, initial, max, 0)));
});

test("computeBackoffDelay keeps jittered delays within [cap*(1-ratio), cap]", () => {
  const initial = 1_000;
  const max = 30_000;
  const ratio = 0.5;

  for (const rng of [() => 0, () => 0.5, () => 0.999]) {
    const value = computeBackoffDelay(3, initial, max, ratio, rng);
    const cap = 4_000;
    assert(value >= cap * (1 - ratio), `${value} below floor`);
    assert(value <= cap, `${value} above cap`);
  }

  // rng() === 0 yields the floor; full jitter ratio yields [0, cap].
  assertEquals(
    computeBackoffDelay(1, initial, max, 1, () => 0),
    0,
  );
  assertEquals(
    computeBackoffDelay(1, initial, max, 1, () => 1),
    1_000,
  );
});

test("runControlPlaneWebSocketClient returns without opening a socket when no URL is configured", async () => {
  const originalWebSocket = globalThis.WebSocket;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: class ThrowingWebSocket {
      constructor() {
        throw new Error("WebSocket should not be created");
      }
    },
  });

  try {
    await runControlPlaneWebSocketClient(
      baseConfig,
      createRuntime(),
      new AbortController().signal,
    );
  } finally {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
  }
});

test("runControlPlaneWebSocketClient opens sockets, sends heartbeats, and closes on abort", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "open";
    const abortController = new AbortController();
    const client = runControlPlaneWebSocketClient(
      { ...baseConfig, ...cloudAuth },
      createRuntime(),
      abortController.signal,
      status,
      silentLogger,
    );

    await waitUntil(() => FakeWebSocket.instances[0]?.sent.length > 0);
    const socket = FakeWebSocket.instances[0];
    abortController.abort();
    await client;

    assertEquals(socket.url, "wss://cloud.example/ws");
    assertEquals(socket.options?.headers?.Authorization, "Bearer access-token");
    assertEquals(socket.closed, true);
    assertEquals(JSON.parse(socket.sent[0]).type, "heartbeat");
  });
});

test("runControlPlaneWebSocketClient never rejects when opening keeps failing", async () => {
  // websocketUrl is set but auth config is missing => openWebSocket throws on
  // every attempt. The loop must absorb it and keep retrying, never reject.
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "open";
    const abortController = new AbortController();
    const client = runControlPlaneWebSocketClient(
      { ...baseConfig, websocketUrl: cloudAuth.websocketUrl },
      createRuntime(),
      abortController.signal,
      status,
      silentLogger,
    );

    await waitUntil(() => status.reconnectAttempt >= 2);
    abortController.abort();
    // Resolves (does not throw) => the supervision loop is uncrashable.
    await client;
    assertEquals(FakeWebSocket.instances.length, 0);
  });
});

test("runControlPlaneWebSocketClient escalates backoff on a flapping peer (anti-flap)", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "openThenClose";
    const abortController = new AbortController();
    const client = runControlPlaneWebSocketClient(
      { ...baseConfig, ...cloudAuth, reconnectStableThresholdMs: 10_000 },
      createRuntime(),
      abortController.signal,
      status,
      silentLogger,
    );

    // Each instant open/close must increment the attempt counter rather than
    // resetting it to zero (which would cause a tight reconnect storm).
    await waitUntil(() => status.reconnectAttempt >= 3, 400);
    abortController.abort();
    await client;
    assert(status.reconnectAttempt >= 3);
    assert(FakeWebSocket.instances.length >= 3);
  });
});

test("runControlPlaneWebSocketClient force-closes a half-open socket via the watchdog", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "openSilent";
    const abortController = new AbortController();
    const client = runControlPlaneWebSocketClient(
      {
        ...baseConfig,
        ...cloudAuth,
        heartbeatIntervalMs: 5,
        heartbeatTimeoutFactor: 2,
      },
      createRuntime(),
      abortController.signal,
      status,
      silentLogger,
    );

    // A silent (no inbound) socket is force-closed and reconnected.
    await waitUntil(() => FakeWebSocket.instances.length >= 2, 400);
    abortController.abort();
    await client;
    assertEquals(FakeWebSocket.instances[0].closed, true);
  });
});

test("runControlPlaneWebSocketClient keeps a socket with inbound traffic open", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "openWithInbound";
    const abortController = new AbortController();
    const client = runControlPlaneWebSocketClient(
      {
        ...baseConfig,
        ...cloudAuth,
        heartbeatIntervalMs: 5,
        heartbeatTimeoutFactor: 2,
      },
      createRuntime(),
      abortController.signal,
      status,
      silentLogger,
    );

    await waitUntil(() => status.connectionState === "open");
    // Let several watchdog windows elapse while inbound frames keep arriving.
    await delayMs(60);
    assertEquals(FakeWebSocket.instances.length, 1);
    assertEquals(FakeWebSocket.instances[0].closed, false);

    abortController.abort();
    await client;
  });
});

test("runControlPlaneWebSocketClient retries when the socket never opens (connect timeout)", async () => {
  await withFakeCloud(async ({ status }) => {
    FakeWebSocket.behavior = "neverOpen";
    const abortController = new AbortController();
    const client = runControlPlaneWebSocketClient(
      { ...baseConfig, ...cloudAuth, connectTimeoutMs: 10 },
      createRuntime(),
      abortController.signal,
      status,
      silentLogger,
    );

    await waitUntil(() => FakeWebSocket.instances.length >= 2, 400);
    abortController.abort();
    await client;
    assertEquals(FakeWebSocket.instances[0].closed, true);
  });
});

test("runControlPlaneWebSocketClient does not hang when aborted during the token fetch", async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const abortController = new AbortController();
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: () => {
      // Shutdown arrives while the token is still being fetched.
      abortController.abort();
      return Promise.resolve(Response.json({ access_token: "access-token" }));
    },
  });
  FakeWebSocket.instances = [];
  FakeWebSocket.behavior = "open";
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  try {
    // Must resolve promptly (not hang) and must not open a socket.
    await runControlPlaneWebSocketClient(
      { ...baseConfig, ...cloudAuth },
      createRuntime(),
      abortController.signal,
      createRuntimeStatus(),
      silentLogger,
    );
    assertEquals(FakeWebSocket.instances.length, 0);
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
  }
});

function createRuntime(): ConnectorRuntime {
  return new ConnectorRuntime({
    protocolExecutor: {
      execute: () => Promise.resolve({ statusCode: 204 }),
    } as unknown as ProtocolExecutor,
    logger: silentLogger,
  });
}

/** Stubs fetch (token endpoint) and WebSocket, restoring them afterwards. */
async function withFakeCloud(
  run: (ctx: {
    status: ReturnType<typeof createRuntimeStatus>;
  }) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "https://identity.example/oauth/token") {
        return Promise.resolve(Response.json({ access_token: "access-token" }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    },
  });
  FakeWebSocket.instances = [];
  FakeWebSocket.behavior = "open";
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  try {
    await run({ status: createRuntimeStatus() });
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
  }
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  condition: () => boolean,
  maxAttempts = 100,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (condition()) {
      return;
    }
    await delayMs(1);
  }

  throw new Error("Condition was not met in time");
}

type FakeBehavior =
  | "open"
  | "openThenClose"
  | "openSilent"
  | "openWithInbound"
  | "neverOpen";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static behavior: FakeBehavior = "open";
  readonly sent: string[] = [];
  readonly url: string;
  readonly options?: { headers?: Record<string, string> };
  readyState = FakeWebSocket.OPEN;
  closed = false;
  #inboundTimer: ReturnType<typeof setInterval> | undefined;

  constructor(url: string, options?: { headers?: Record<string, string> }) {
    super();
    this.url = url;
    this.options = options;
    FakeWebSocket.instances.push(this);
    const behavior = FakeWebSocket.behavior;
    if (behavior === "neverOpen") {
      this.readyState = FakeWebSocket.CONNECTING;
      return;
    }

    queueMicrotask(() => {
      this.dispatchEvent(new Event("open"));
      if (behavior === "openThenClose") {
        this.close();
      } else if (behavior === "openWithInbound") {
        this.#inboundTimer = setInterval(
          () => this.receive('{"type":"heartbeat"}'),
          1,
        );
      }
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  receive(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    if (this.#inboundTimer !== undefined) {
      clearInterval(this.#inboundTimer);
      this.#inboundTimer = undefined;
    }
    this.dispatchEvent(new Event("close"));
  }
}

const runControlPlaneWebSocketClient: typeof runClient = (
  config,
  runtime,
  signal,
  status,
  logger,
) =>
  runClient(
    config,
    runtime,
    signal,
    status,
    logger,
    (url, options) =>
      new FakeWebSocket(url, options) as unknown as import("ws").WebSocket,
  );
