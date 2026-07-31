import { assertEquals, assertThrows } from "@std/assert";
import { loadConfig } from "./config.ts";

Deno.test("loadConfig uses documented defaults", () => {
  const config = loadConfig({});

  assertEquals(config, {
    host: "0.0.0.0",
    port: 8080,
    websocketUrl: undefined,
    controlPlaneUrl: undefined,
    tokenEndpoint: undefined,
    clientId: undefined,
    clientSecret: undefined,
    allowInsecureConnections: false,
    managementUrl: undefined,
    pairingCode: undefined,
    connectorDisplayName: "Edge Connector",
    managementPollIntervalMs: 5_000,
    functionsDir: "functions",
    dataDirectory: "data",
    extensionPolicyFile: undefined,
    trustedPublishersFile: undefined,
    heartbeatIntervalMs: 30_000,
    reconnectInitialDelayMs: 1_000,
    reconnectMaxDelayMs: 30_000,
    connectTimeoutMs: 10_000,
    reconnectStableThresholdMs: 5_000,
    heartbeatTimeoutFactor: 3,
    tokenFetchTimeoutMs: 10_000,
    reconnectJitterRatio: 0.5,
    livenessStaleMs: 120_000,
    logLevel: "info",
  });
});

Deno.test("loadConfig reads explicit values and trims optional paths", () => {
  const config = loadConfig({
    EDGE_CONNECTOR_BIND_HOST: "127.0.0.1",
    EDGE_CONNECTOR_BIND_PORT: "9090",
    EDGE_CONNECTOR_WS_URL: " wss://cloud.example/ws ",
    EDGE_CONNECTOR_TOKEN_ENDPOINT: " https://identity.example/oauth/token ",
    EDGE_CONNECTOR_CLIENT_ID: " client-id ",
    EDGE_CONNECTOR_CLIENT_SECRET: " client-secret ",
    EDGE_CONNECTOR_DATA_DIRECTORY: " connector-data ",
    EDGE_CONNECTOR_EXTENSION_POLICY_FILE: " config/policy.json ",
    EDGE_CONNECTOR_TRUSTED_PUBLISHERS_FILE: " config/publishers.json ",
    EDGE_CONNECTOR_HEARTBEAT_INTERVAL_SECONDS: "5",
    EDGE_CONNECTOR_RECONNECT_INITIAL_SECONDS: "2",
    EDGE_CONNECTOR_RECONNECT_MAX_SECONDS: "9",
    EDGE_CONNECTOR_LOG_LEVEL: " DEBUG ",
  });

  assertEquals(config.host, "127.0.0.1");
  assertEquals(config.port, 9090);
  assertEquals(config.websocketUrl, "wss://cloud.example/ws");
  assertEquals(config.tokenEndpoint, "https://identity.example/oauth/token");
  assertEquals(config.clientId, "client-id");
  assertEquals(config.clientSecret, "client-secret");
  assertEquals(config.dataDirectory, "connector-data");
  assertEquals(config.extensionPolicyFile, "config/policy.json");
  assertEquals(config.trustedPublishersFile, "config/publishers.json");
  assertEquals(config.heartbeatIntervalMs, 5_000);
  assertEquals(config.reconnectInitialDelayMs, 2_000);
  assertEquals(config.reconnectMaxDelayMs, 9_000);
  assertEquals(config.logLevel, "debug");
});

Deno.test("loadConfig rejects invalid URL values", () => {
  assertThrows(
    () => loadConfig({ EDGE_CONNECTOR_WS_URL: "cloud.example/ws" }),
    Error,
    "EDGE_CONNECTOR_WS_URL must be a valid absolute URL",
  );
  assertThrows(
    () => loadConfig({ EDGE_CONNECTOR_TOKEN_ENDPOINT: "wss://cloud.example" }),
    Error,
    "EDGE_CONNECTOR_TOKEN_ENDPOINT must use one of these protocols: https:",
  );
});

Deno.test("loadConfig requires authentication settings when cloud auth is used", () => {
  assertThrows(
    () => loadConfig({ EDGE_CONNECTOR_WS_URL: "wss://cloud.example/ws" }),
    Error,
    "Control-plane authentication requires EDGE_CONNECTOR_TOKEN_ENDPOINT or EDGE_CONNECTOR_CONTROL_PLANE_URL, EDGE_CONNECTOR_CLIENT_ID, EDGE_CONNECTOR_CLIENT_SECRET",
  );
});

Deno.test("loadConfig keeps original environment aliases operational", () => {
  const config = loadConfig({
    CLOUD_CONNECTOR_WS_URL: "wss://legacy.example/ws",
    CLOUD_CONNECTOR_HOST: "https://legacy.example",
    CLOUD_CONNECTOR_CLIENT_ID: "legacy-client",
    CLOUD_CONNECTOR_CLIENT_SECRET: "legacy-secret",
    CLOUD_CONNECTOR_FUNCTIONS_DIR: "legacy-functions",
    CONNECTOR_HOST: "127.0.0.2",
    CONNECTOR_PORT: "8181",
  });

  assertEquals(config.websocketUrl, "wss://legacy.example/ws");
  assertEquals(config.controlPlaneUrl, "https://legacy.example/");
  assertEquals(config.clientId, "legacy-client");
  assertEquals(config.clientSecret, "legacy-secret");
  assertEquals(config.functionsDir, "legacy-functions");
  assertEquals(config.host, "127.0.0.2");
  assertEquals(config.port, 8181);
});

Deno.test("loadConfig requires secure transport unless explicitly enabled for development", () => {
  assertThrows(
    () =>
      loadConfig({
        EDGE_CONNECTOR_WS_URL: "ws://localhost:8081/ws",
        EDGE_CONNECTOR_TOKEN_ENDPOINT: "http://localhost:8081/token",
        EDGE_CONNECTOR_CLIENT_ID: "local",
        EDGE_CONNECTOR_CLIENT_SECRET: "local",
      }),
    Error,
    "EDGE_CONNECTOR_WS_URL must use one of these protocols: wss:",
  );
  const config = loadConfig({
    EDGE_CONNECTOR_ALLOW_INSECURE_CONNECTIONS: "true",
    EDGE_CONNECTOR_WS_URL: "ws://localhost:8081/ws",
    EDGE_CONNECTOR_TOKEN_ENDPOINT: "http://localhost:8081/token",
    EDGE_CONNECTOR_CLIENT_ID: "local",
    EDGE_CONNECTOR_CLIENT_SECRET: "local",
  });
  assertEquals(config.allowInsecureConnections, true);
});

Deno.test("loadConfig rejects non-positive and non-integer numbers", () => {
  for (const value of ["0", "-1", "1.5", "abc"]) {
    assertThrows(
      () => loadConfig({ EDGE_CONNECTOR_BIND_PORT: value }),
      Error,
      "EDGE_CONNECTOR_BIND_PORT must be a positive integer",
    );
  }
  assertThrows(
    () => loadConfig({ EDGE_CONNECTOR_BIND_PORT: "65536" }),
    Error,
    "must be between 1 and 65535",
  );
});

Deno.test("loadConfig reads the resilience tuning settings", () => {
  const config = loadConfig({
    EDGE_CONNECTOR_CONNECT_TIMEOUT_SECONDS: "20",
    EDGE_CONNECTOR_RECONNECT_STABLE_SECONDS: "8",
    EDGE_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR: "5",
    EDGE_CONNECTOR_TOKEN_TIMEOUT_SECONDS: "7",
    EDGE_CONNECTOR_RECONNECT_JITTER_RATIO: "0.25",
    EDGE_CONNECTOR_RECONNECT_MAX_SECONDS: "30",
    EDGE_CONNECTOR_LIVENESS_STALE_SECONDS: "200",
  });

  assertEquals(config.connectTimeoutMs, 20_000);
  assertEquals(config.reconnectStableThresholdMs, 8_000);
  assertEquals(config.heartbeatTimeoutFactor, 5);
  assertEquals(config.tokenFetchTimeoutMs, 7_000);
  assertEquals(config.reconnectJitterRatio, 0.25);
  assertEquals(config.livenessStaleMs, 200_000);
});

Deno.test("loadConfig allows disabling the heartbeat watchdog with factor 0", () => {
  const config = loadConfig({ EDGE_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR: "0" });
  assertEquals(config.heartbeatTimeoutFactor, 0);
});

Deno.test("loadConfig rejects a jitter ratio outside 0..1", () => {
  for (const value of ["-0.1", "1.5", "abc"]) {
    assertThrows(
      () => loadConfig({ EDGE_CONNECTOR_RECONNECT_JITTER_RATIO: value }),
      Error,
      "EDGE_CONNECTOR_RECONNECT_JITTER_RATIO must be a number between 0 and 1",
    );
  }
});

Deno.test("loadConfig rejects a negative heartbeat timeout factor", () => {
  assertThrows(
    () => loadConfig({ EDGE_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR: "-1" }),
    Error,
    "EDGE_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR must be a non-negative integer",
  );
});

Deno.test("loadConfig rejects invalid log levels", () => {
  assertThrows(
    () => loadConfig({ EDGE_CONNECTOR_LOG_LEVEL: "trace" }),
    Error,
    "EDGE_CONNECTOR_LOG_LEVEL must be one of: error, warn, info, debug",
  );
});

Deno.test("loadConfig requires the liveness window to exceed the max backoff", () => {
  assertThrows(
    () =>
      loadConfig({
        EDGE_CONNECTOR_RECONNECT_MAX_SECONDS: "120",
        EDGE_CONNECTOR_LIVENESS_STALE_SECONDS: "60",
      }),
    Error,
    "EDGE_CONNECTOR_LIVENESS_STALE_SECONDS must be greater than",
  );
});

Deno.test("loadConfig requires the liveness window to exceed the heartbeat interval", () => {
  assertThrows(
    () =>
      loadConfig({
        EDGE_CONNECTOR_RECONNECT_MAX_SECONDS: "5",
        EDGE_CONNECTOR_HEARTBEAT_INTERVAL_SECONDS: "200",
        EDGE_CONNECTOR_LIVENESS_STALE_SECONDS: "120",
      }),
    Error,
    "EDGE_CONNECTOR_LIVENESS_STALE_SECONDS must be greater than",
  );
});
