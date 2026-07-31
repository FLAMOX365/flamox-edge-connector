import { defaultLogLevel, isLogLevel, type LogLevel } from "./logger.ts";

export type ConnectorConfig = {
  host: string;
  port: number;
  websocketUrl?: string;
  /** Optional original-style base URL used for `.well-known` discovery. */
  controlPlaneUrl?: string;
  /** Optional direct OAuth2 token endpoint used by the managed control plane. */
  tokenEndpoint?: string;
  clientId?: string;
  clientSecret?: string;
  allowInsecureConnections: boolean;
  /** Managed FLAMOX365 API used for pairing and Desired/Observed State polling. */
  managementUrl?: string;
  /** One-time code consumed only when no connector identity exists yet. */
  pairingCode?: string;
  connectorDisplayName: string;
  managementPollIntervalMs: number;
  /** Customer-authored TypeScript/JavaScript and YAML function directory. */
  functionsDir: string;
  /** Durable connector-owned state and immutable extension packages. */
  dataDirectory: string;
  /** Local allow-list. Missing means deny every extension. */
  extensionPolicyFile?: string;
  /** Locally trusted Ed25519 publisher keys. Missing means trust nobody. */
  trustedPublishersFile?: string;
  heartbeatIntervalMs: number;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
  /** Max time to wait for the WebSocket "open" event before retrying. */
  connectTimeoutMs: number;
  /** Min continuous open duration before the backoff counter resets (anti-flap). */
  reconnectStableThresholdMs: number;
  /**
   * Number of heartbeat intervals without ANY inbound frame after which the
   * peer is treated as dead and the socket is force-closed. 0 disables the
   * watchdog.
   */
  heartbeatTimeoutFactor: number;
  /** Timeout applied to the access-token fetches. */
  tokenFetchTimeoutMs: number;
  /** Fraction of the backoff delay that is randomized (equal jitter), 0..1. */
  reconnectJitterRatio: number;
  /** Staleness window for /health liveness; must exceed reconnectMaxDelayMs. */
  livenessStaleMs: number;
  /** Runtime log verbosity. */
  logLevel: LogLevel;
};

const defaultPort = 8080;
const defaultFunctionsDirectory = "functions";
const defaultDataDirectory = "data";
const defaultManagementPollSeconds = 5;
const defaultHeartbeatSeconds = 30;
const defaultReconnectInitialSeconds = 1;
const defaultReconnectMaxSeconds = 30;
const defaultConnectTimeoutSeconds = 10;
const defaultReconnectStableSeconds = 5;
const defaultHeartbeatTimeoutFactor = 3;
const defaultTokenFetchTimeoutSeconds = 10;
const defaultReconnectJitterRatio = 0.5;
const defaultLivenessStaleSeconds = 120;

export function loadConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): ConnectorConfig {
  const allowInsecureConnections = readBoolean(
    environmentValue(
      env,
      "EDGE_CONNECTOR_ALLOW_INSECURE_CONNECTIONS",
    ),
    false,
    "EDGE_CONNECTOR_ALLOW_INSECURE_CONNECTIONS",
  );
  const websocketUrl = readOptionalUrl(
    environmentValue(env, "EDGE_CONNECTOR_WS_URL", "CLOUD_CONNECTOR_WS_URL"),
    "EDGE_CONNECTOR_WS_URL",
    allowInsecureConnections ? ["wss:", "ws:"] : ["wss:"],
  );
  const controlPlaneUrl = readOptionalUrl(
    environmentValue(
      env,
      "EDGE_CONNECTOR_CONTROL_PLANE_URL",
      "CLOUD_CONNECTOR_HOST",
    ),
    "EDGE_CONNECTOR_CONTROL_PLANE_URL",
    allowInsecureConnections ? ["https:", "http:"] : ["https:"],
  );
  const tokenEndpoint = readOptionalUrl(
    environmentValue(env, "EDGE_CONNECTOR_TOKEN_ENDPOINT"),
    "EDGE_CONNECTOR_TOKEN_ENDPOINT",
    allowInsecureConnections ? ["https:", "http:"] : ["https:"],
  );
  const managementUrl = readOptionalUrl(
    environmentValue(env, "EDGE_CONNECTOR_MANAGEMENT_URL"),
    "EDGE_CONNECTOR_MANAGEMENT_URL",
    allowInsecureConnections ? ["https:", "http:"] : ["https:"],
  );
  const pairingCode = readOptionalText(
    environmentValue(env, "EDGE_CONNECTOR_PAIRING_CODE"),
  );
  if (pairingCode && !managementUrl) {
    throw new Error(
      "EDGE_CONNECTOR_PAIRING_CODE requires EDGE_CONNECTOR_MANAGEMENT_URL",
    );
  }
  const clientId = readOptionalText(
    environmentValue(
      env,
      "EDGE_CONNECTOR_CLIENT_ID",
      "CLOUD_CONNECTOR_CLIENT_ID",
    ),
  );
  const clientSecret = readOptionalText(
    environmentValue(
      env,
      "EDGE_CONNECTOR_CLIENT_SECRET",
      "CLOUD_CONNECTOR_CLIENT_SECRET",
    ),
  );

  validateControlPlaneAuth(
    websocketUrl,
    controlPlaneUrl,
    tokenEndpoint,
    clientId,
    clientSecret,
  );

  const reconnectMaxDelayMs = readInteger(
    environmentValue(
      env,
      "EDGE_CONNECTOR_RECONNECT_MAX_SECONDS",
      "CLOUD_CONNECTOR_RECONNECT_MAX_SECONDS",
    ),
    defaultReconnectMaxSeconds,
    "EDGE_CONNECTOR_RECONNECT_MAX_SECONDS",
  ) * 1000;
  const heartbeatIntervalMs = readInteger(
    environmentValue(
      env,
      "EDGE_CONNECTOR_HEARTBEAT_INTERVAL_SECONDS",
      "CLOUD_CONNECTOR_HEARTBEAT_INTERVAL_SECONDS",
    ),
    defaultHeartbeatSeconds,
    "EDGE_CONNECTOR_HEARTBEAT_INTERVAL_SECONDS",
  ) * 1000;
  const livenessStaleMs = readInteger(
    environmentValue(
      env,
      "EDGE_CONNECTOR_LIVENESS_STALE_SECONDS",
      "CLOUD_CONNECTOR_LIVENESS_STALE_SECONDS",
    ),
    defaultLivenessStaleSeconds,
    "EDGE_CONNECTOR_LIVENESS_STALE_SECONDS",
  ) * 1000;

  validateLivenessWindow(
    livenessStaleMs,
    reconnectMaxDelayMs,
    heartbeatIntervalMs,
  );

  return {
    host: readOptionalText(
      environmentValue(env, "EDGE_CONNECTOR_BIND_HOST", "CONNECTOR_HOST"),
    ) ?? "0.0.0.0",
    port: readPort(
      environmentValue(env, "EDGE_CONNECTOR_BIND_PORT", "CONNECTOR_PORT"),
      defaultPort,
      "EDGE_CONNECTOR_BIND_PORT",
    ),
    websocketUrl,
    controlPlaneUrl,
    tokenEndpoint,
    clientId,
    clientSecret,
    allowInsecureConnections,
    managementUrl,
    pairingCode,
    connectorDisplayName: readOptionalText(
      environmentValue(env, "EDGE_CONNECTOR_DISPLAY_NAME"),
    ) ?? "Edge Connector",
    managementPollIntervalMs: readInteger(
      environmentValue(env, "EDGE_CONNECTOR_MANAGEMENT_POLL_SECONDS"),
      defaultManagementPollSeconds,
      "EDGE_CONNECTOR_MANAGEMENT_POLL_SECONDS",
    ) * 1000,
    functionsDir: readOptionalPath(
      environmentValue(
        env,
        "EDGE_CONNECTOR_FUNCTIONS_DIR",
        "CLOUD_CONNECTOR_FUNCTIONS_DIR",
      ),
    ) ?? defaultFunctionsDirectory,
    dataDirectory: readOptionalPath(env.EDGE_CONNECTOR_DATA_DIRECTORY) ??
      defaultDataDirectory,
    extensionPolicyFile: readOptionalPath(
      env.EDGE_CONNECTOR_EXTENSION_POLICY_FILE,
    ),
    trustedPublishersFile: readOptionalPath(
      env.EDGE_CONNECTOR_TRUSTED_PUBLISHERS_FILE,
    ),
    heartbeatIntervalMs,
    reconnectInitialDelayMs: readInteger(
      environmentValue(
        env,
        "EDGE_CONNECTOR_RECONNECT_INITIAL_SECONDS",
        "CLOUD_CONNECTOR_RECONNECT_INITIAL_SECONDS",
      ),
      defaultReconnectInitialSeconds,
      "EDGE_CONNECTOR_RECONNECT_INITIAL_SECONDS",
    ) * 1000,
    reconnectMaxDelayMs,
    connectTimeoutMs: readInteger(
      environmentValue(
        env,
        "EDGE_CONNECTOR_CONNECT_TIMEOUT_SECONDS",
        "CLOUD_CONNECTOR_CONNECT_TIMEOUT_SECONDS",
      ),
      defaultConnectTimeoutSeconds,
      "EDGE_CONNECTOR_CONNECT_TIMEOUT_SECONDS",
    ) * 1000,
    reconnectStableThresholdMs: readInteger(
      environmentValue(
        env,
        "EDGE_CONNECTOR_RECONNECT_STABLE_SECONDS",
        "CLOUD_CONNECTOR_RECONNECT_STABLE_SECONDS",
      ),
      defaultReconnectStableSeconds,
      "EDGE_CONNECTOR_RECONNECT_STABLE_SECONDS",
    ) * 1000,
    heartbeatTimeoutFactor: readNonNegativeInteger(
      environmentValue(
        env,
        "EDGE_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR",
        "CLOUD_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR",
      ),
      defaultHeartbeatTimeoutFactor,
      "EDGE_CONNECTOR_HEARTBEAT_TIMEOUT_FACTOR",
    ),
    tokenFetchTimeoutMs: readInteger(
      environmentValue(
        env,
        "EDGE_CONNECTOR_TOKEN_TIMEOUT_SECONDS",
        "CLOUD_CONNECTOR_TOKEN_TIMEOUT_SECONDS",
      ),
      defaultTokenFetchTimeoutSeconds,
      "EDGE_CONNECTOR_TOKEN_TIMEOUT_SECONDS",
    ) * 1000,
    reconnectJitterRatio: readRatio(
      environmentValue(
        env,
        "EDGE_CONNECTOR_RECONNECT_JITTER_RATIO",
        "CLOUD_CONNECTOR_RECONNECT_JITTER_RATIO",
      ),
      defaultReconnectJitterRatio,
      "EDGE_CONNECTOR_RECONNECT_JITTER_RATIO",
    ),
    livenessStaleMs,
    logLevel: readLogLevel(
      environmentValue(
        env,
        "EDGE_CONNECTOR_LOG_LEVEL",
        "CLOUD_CONNECTOR_LOG_LEVEL",
      ),
    ),
  };
}

function readLogLevel(value: string | undefined): LogLevel {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return defaultLogLevel;
  }

  if (!isLogLevel(trimmed)) {
    throw new Error(
      "EDGE_CONNECTOR_LOG_LEVEL must be one of: error, warn, info, debug",
    );
  }

  return trimmed;
}

function validateLivenessWindow(
  livenessStaleMs: number,
  reconnectMaxDelayMs: number,
  heartbeatIntervalMs: number,
): void {
  // The supervision loop refreshes its liveness tick at most once per backoff
  // (while reconnecting) and once per heartbeat (while connected). The window
  // must exceed both, or a connector that is healthy-but-idle or legitimately
  // backing off would falsely fail /health and be killed mid-recovery.
  const minimum = Math.max(reconnectMaxDelayMs, heartbeatIntervalMs);
  if (livenessStaleMs <= minimum) {
    throw new Error(
      "EDGE_CONNECTOR_LIVENESS_STALE_SECONDS must be greater than both " +
        "EDGE_CONNECTOR_RECONNECT_MAX_SECONDS and " +
        "EDGE_CONNECTOR_HEARTBEAT_INTERVAL_SECONDS so a healthy or " +
        "recovering connector is not killed mid-recovery",
    );
  }
}

function validateControlPlaneAuth(
  websocketUrl: string | undefined,
  controlPlaneUrl: string | undefined,
  tokenEndpoint: string | undefined,
  clientId: string | undefined,
  clientSecret: string | undefined,
): void {
  const hasConnectionConfig = websocketUrl !== undefined ||
    controlPlaneUrl !== undefined ||
    tokenEndpoint !== undefined ||
    clientId !== undefined ||
    clientSecret !== undefined;
  if (!hasConnectionConfig) {
    return;
  }

  const missingVariables: string[] = [];
  if (!websocketUrl) missingVariables.push("EDGE_CONNECTOR_WS_URL");
  if (!controlPlaneUrl && !tokenEndpoint) {
    missingVariables.push(
      "EDGE_CONNECTOR_TOKEN_ENDPOINT or EDGE_CONNECTOR_CONTROL_PLANE_URL",
    );
  }
  if (!clientId) missingVariables.push("EDGE_CONNECTOR_CLIENT_ID");
  if (!clientSecret) missingVariables.push("EDGE_CONNECTOR_CLIENT_SECRET");

  if (missingVariables.length > 0) {
    throw new Error(
      `Control-plane authentication requires ${missingVariables.join(", ")}`,
    );
  }
}

function environmentValue(
  env: Record<string, string | undefined>,
  primary: string,
  legacy?: string,
): string | undefined {
  return env[primary] ?? (legacy ? env[legacy] : undefined);
}

function readBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be either true or false`);
}

function readOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readOptionalPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readOptionalUrl(
  value: string | undefined,
  name: string,
  allowedProtocols: string[],
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (error) {
    throw new Error(`${name} must be a valid absolute URL`, { cause: error });
  }

  if (!allowedProtocols.includes(url.protocol)) {
    throw new Error(
      `${name} must use one of these protocols: ${allowedProtocols.join(", ")}`,
    );
  }

  return url.toString();
}

function readInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readPort(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const port = readInteger(value, fallback, name);
  if (port > 65_535) {
    throw new Error(`${name} must be between 1 and 65535`);
  }
  return port;
}

function readNonNegativeInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return parsed;
}

function readRatio(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number.parseFloat(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be a number between 0 and 1`);
  }

  return parsed;
}
