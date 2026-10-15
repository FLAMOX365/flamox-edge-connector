import { serveHttp, type HttpServer } from "./http-server.ts";
import type { ConnectorConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import {
  type ControlPlaneAgent,
  createControlPlaneAgent,
} from "./control-plane-agent.ts";
import { ConnectorRuntime } from "./connector.ts";
import {
  ManagedExtensionReleaseVerifier,
  readTrustedPublishersFile,
} from "./extension-integrity.ts";
import { ExtensionManager } from "./extension-manager.ts";
import {
  ManagedExtensionPolicy,
  StaticExtensionPolicy,
} from "./extension-policy.ts";
import type { ExtensionHostCapabilityProvider } from "./extension-host-capabilities.ts";
import { ExtensionProtocolExecutor } from "./extension-protocol-executor.ts";
import { EnvironmentExtensionSecretProvider } from "./extension-secrets.ts";
import { ManagedExtensionSecretProvider } from "./extension-secrets.ts";
import { ExtensionStateStore } from "./extension-state.ts";
import { watchFunctionsDirectory } from "./function-watcher.ts";
import type { RuntimeLogger } from "./logger.ts";
import { createLogger } from "./logger.ts";
import { ProtocolDispatcher } from "./protocol-dispatcher.ts";
import {
  createReloadableProtocolExecutor,
  type ReloadableProtocolExecutor,
} from "./reloadable-request-executor.ts";
import { createRuntimeStatus, type RuntimeStatus } from "./runtime-status.ts";
import { delay, runControlPlaneWebSocketClient } from "./websocket-client.ts";

/** Exit codes (sysexits.h) so a supervisor can distinguish failure modes. */
const EX_SOFTWARE = 70;
const EX_OSERR = 71;
const EX_CONFIG = 78;

/**
 * Preserves the original Functions/YAML/proxy execution path. Managed
 * extensions are composed additively in `createRuntimeBundle`.
 */
export function createProtocolExecutor(
  config: ConnectorConfig,
  logger: RuntimeLogger = createLogger(config.logLevel),
): Promise<ReloadableProtocolExecutor> {
  return createReloadableProtocolExecutor({ config, logger });
}

export type RuntimeBundle = {
  runtime: ConnectorRuntime;
  protocolExecutor: ProtocolDispatcher;
  legacyProtocolExecutor: ReloadableProtocolExecutor;
  extensionManager: ExtensionManager;
  extensionVerifier: ManagedExtensionReleaseVerifier;
  extensionPolicy: ManagedExtensionPolicy;
  extensionSecrets: ManagedExtensionSecretProvider;
  controlPlaneAgent?: ControlPlaneAgent;
};

export type ManagedExtensionRuntime = {
  readonly manager: ExtensionManager;
  readonly verifier: ManagedExtensionReleaseVerifier;
  readonly policy: ManagedExtensionPolicy;
  readonly secrets: ManagedExtensionSecretProvider;
};

export type ExtensionRuntimeOptions = {
  readonly onStateChanged?: () => void;
  readonly hostCapabilities?: ExtensionHostCapabilityProvider;
};

/** In-process connector host shared by the CLI entry point and Desktop app. */
export class ConnectorHost {
  readonly finished: Promise<void>;

  constructor(
    readonly config: ConnectorConfig,
    readonly bundle: RuntimeBundle,
    readonly status: RuntimeStatus,
    private readonly abortController: AbortController,
    tasks: readonly Promise<void>[],
  ) {
    this.finished = Promise.all(tasks).then(() => undefined);
  }

  stop(): void {
    this.bundle.extensionManager.stop();
    this.abortController.abort();
  }
}

export async function createManagedExtensionRuntime(
  config: ConnectorConfig,
  logger: RuntimeLogger = createLogger(config.logLevel),
  options: ExtensionRuntimeOptions = {},
): Promise<ManagedExtensionRuntime> {
  const localPolicy = config.extensionPolicyFile
    ? await StaticExtensionPolicy.fromFile(config.extensionPolicyFile)
    : undefined;
  const verifier = new ManagedExtensionReleaseVerifier(
    config.trustedPublishersFile
      ? await readTrustedPublishersFile(config.trustedPublishersFile)
      : [],
  );
  const policy = new ManagedExtensionPolicy(localPolicy);
  const secrets = new ManagedExtensionSecretProvider(
    new EnvironmentExtensionSecretProvider(),
  );
  if (!config.extensionPolicyFile || !config.trustedPublishersFile) {
    logger.warn(
      "No complete local extension trust configuration was supplied; " +
        "new and restored extensions remain denied.",
    );
  }
  const manager = new ExtensionManager({
    dataDirectory: config.dataDirectory,
    stateStore: new ExtensionStateStore(
      `${config.dataDirectory}/state/extensions.json`,
    ),
    verifier,
    policy,
    secrets,
    hostCapabilities: options.hostCapabilities,
    logger,
  });
  await manager.initialize();
  return { manager, verifier, policy, secrets };
}

export async function createExtensionManager(
  config: ConnectorConfig,
  logger: RuntimeLogger = createLogger(config.logLevel),
): Promise<ExtensionManager> {
  return (await createManagedExtensionRuntime(config, logger)).manager;
}

export async function createRuntimeBundle(
  config: ConnectorConfig,
  logger: RuntimeLogger = createLogger(config.logLevel),
  options: ExtensionRuntimeOptions = {},
): Promise<RuntimeBundle> {
  logger.info("Starting Edge Connector runtime");
  const legacyProtocolExecutor = await createProtocolExecutor(config, logger);
  const managedExtensions = await createManagedExtensionRuntime(
    config,
    logger,
    options,
  );
  const extensionManager = managedExtensions.manager;
  const protocolExecutor = new ProtocolDispatcher(
    new ExtensionProtocolExecutor(extensionManager),
    legacyProtocolExecutor,
  );
  const runtime = new ConnectorRuntime({
    protocolExecutor,
    logger,
  });
  const controlPlaneAgent = await createControlPlaneAgent(
    config,
    {
      manager: extensionManager,
      verifier: managedExtensions.verifier,
      policy: managedExtensions.policy,
      secrets: managedExtensions.secrets,
      onStateChanged: options.onStateChanged,
    },
    logger,
  );
  return {
    runtime,
    protocolExecutor,
    legacyProtocolExecutor,
    extensionManager,
    extensionVerifier: managedExtensions.verifier,
    extensionPolicy: managedExtensions.policy,
    extensionSecrets: managedExtensions.secrets,
    controlPlaneAgent,
  };
}

export async function createRuntime(
  config: ConnectorConfig,
  logger: RuntimeLogger = createLogger(config.logLevel),
): Promise<ConnectorRuntime> {
  return (await createRuntimeBundle(config, logger)).runtime;
}

export function createHandler(
  runtime: ConnectorRuntime,
  config: ConnectorConfig,
  status: RuntimeStatus,
  now: () => number = Date.now,
): (request: Request) => Response {
  return (request) => {
    const url = new URL(request.url);

    // Liveness: the process is recoverable. Fails ONLY when the supervision
    // loop has gone stale (truly wedged) — NOT merely while reconnecting.
    if (url.pathname === "/health") {
      const stale = now() - status.lastTickAt > config.livenessStaleMs;
      if (stale) {
        return Response.json(
          { status: "unhealthy", reason: "supervision loop stalled" },
          { status: 503 },
        );
      }
      return Response.json({ status: "ok" });
    }

    // Readiness: the cloud connection is usable right now. 503 while
    // disconnected/reconnecting de-routes traffic without killing the process.
    if (url.pathname === "/ready") {
      const websocketConfigured = config.websocketUrl !== undefined;
      const websocketConnected = status.connectionState === "open";
      // With no WS configured the connector is a pure HTTP service => ready.
      const ready = !websocketConfigured || websocketConnected;
      return Response.json(
        {
          status: ready ? "ready" : "not_ready",
          websocketConfigured,
          websocketConnected,
        },
        { status: ready ? 200 : 503 },
      );
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    return new Response("Not found", { status: 404 });
  };
}

/** Starts the complete HTTP, legacy Functions, WebSocket, and managed-control host. */
export async function startConnectorHost(
  config: ConnectorConfig,
  logger: RuntimeLogger = createLogger(config.logLevel),
  options: ExtensionRuntimeOptions = {},
): Promise<ConnectorHost> {
  const bundle = await createRuntimeBundle(config, logger, options);
  const status = createRuntimeStatus(Date.now(), options.onStateChanged);
  const handler = createHandler(bundle.runtime, config, status);
  const abortController = new AbortController();
  let server: HttpServer;
  try {
    server = await serveHttp(
      {
        hostname: config.host,
        port: config.port,
        signal: abortController.signal,
      },
      handler,
      (socket) => bundle.runtime.attachWebSocket(socket),
    );
  } catch (error) {
    bundle.extensionManager.stop();
    throw error;
  }
  const tasks: Promise<void>[] = [
    superviseHttpServer(
      server,
      config,
      handler,
      abortController.signal,
      logger,
      (socket) => bundle.runtime.attachWebSocket(socket),
    ),
    superviseTask(
      "functions-watcher",
      () =>
        watchFunctionsDirectory({
          functionsDir: config.functionsDir,
          logger,
          reload: (reason) => bundle.legacyProtocolExecutor.reload(reason),
          signal: abortController.signal,
        }),
      abortController.signal,
      logger,
    ),
  ];
  if (config.websocketUrl) {
    tasks.push(
      superviseTask(
        "websocket-client",
        () =>
          runControlPlaneWebSocketClient(
            config,
            bundle.runtime,
            abortController.signal,
            status,
            logger,
          ),
        abortController.signal,
        logger,
      ),
    );
  }
  if (bundle.controlPlaneAgent) {
    tasks.push(
      superviseTask(
        "managed-control-plane",
        () => bundle.controlPlaneAgent!.run(abortController.signal),
        abortController.signal,
        logger,
      ),
    );
  }
  return new ConnectorHost(config, bundle, status, abortController, tasks);
}

/**
 * Runs `factory` and restarts it (with a small backoff) if it ever settles or
 * throws while the signal is not aborted. The WS client already loops forever
 * internally; this is the outer safety net guaranteeing it is never left dead.
 */
async function superviseTask(
  name: string,
  factory: () => Promise<void>,
  signal: AbortSignal,
  logger: RuntimeLogger,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await factory();
    } catch (error) {
      logger.error(`Task "${name}" crashed`, error);
    }
    if (signal.aborted) break;
    logger.error(`Task "${name}" exited unexpectedly; restarting`);
    await delay(1_000, signal);
  }
}

/**
 * Binds the HTTP server and rebinds it if it ever stops unexpectedly. The first
 * bind is the caller's responsibility (fatal); this supervises rebinds only.
 */
async function superviseHttpServer(
  initial: HttpServer,
  config: ConnectorConfig,
  handler: (request: Request) => Response,
  signal: AbortSignal,
  logger: RuntimeLogger,
  onWebSocket: Parameters<typeof serveHttp>[2],
): Promise<void> {
  let server: HttpServer | undefined = initial;
  while (!signal.aborted) {
    if (server !== undefined) {
      try {
        await server.finished;
      } catch (error) {
        logger.error("HTTP server error", error);
      }
      if (signal.aborted) break;
      logger.error("HTTP server stopped unexpectedly; rebinding");
    }

    await delay(1_000, signal);
    if (signal.aborted) break;

    try {
      server = await serveHttp(
        { hostname: config.host, port: config.port, signal },
        handler,
        onWebSocket,
      );
    } catch (error) {
      // Do not await the stale (finished) server again on the next iteration;
      // keep retrying the rebind on a fixed interval until it succeeds.
      server = undefined;
      logger.error("Failed to rebind HTTP server", error);
    }
  }
}

// Main entry point
if (import.meta.main) {
  // Startup latch: before startup completes, faults are fatal and visible so a
  // broken config/bind crash-loops loudly instead of being silently absorbed.
  // After startup, stray rejections/errors are logged and swallowed so a
  // transient steady-state fault can never terminate the process.
  let startupComplete = false;
  let shuttingDown = false;

  process.on("unhandledRejection", (error: unknown) => {
    if (!startupComplete) {
      console.error(error);
      process.exit(EX_SOFTWARE);
    }
    try {
      console.error("Unhandled runtime rejection", error);
    } catch {
      /* Logging must not stop recovery. */
    }
  });
  process.on("uncaughtException", (error: Error) => {
    if (!startupComplete) {
      console.error(error);
      process.exit(EX_SOFTWARE);
    }
    try {
      console.error("Uncaught runtime error", error);
    } catch {
      /* Logging must not stop recovery. */
    }
  });

  let config: ConnectorConfig;
  let logger: RuntimeLogger = createLogger();
  try {
    config = loadConfig();
    logger = createLogger(config.logLevel);
  } catch (error) {
    console.error(
      "[flamox-edge-connector] FATAL: invalid configuration:",
      error instanceof Error ? error.message : error,
    );
    process.exit(EX_CONFIG);
  }

  let host: ConnectorHost;
  try {
    host = await startConnectorHost(config, logger);
  } catch (error) {
    console.error(
      "[flamox-edge-connector] FATAL: failed to initialize or bind runtime:",
      error,
    );
    process.exit(
      error instanceof Error && "code" in error && error.code === "EADDRINUSE"
        ? EX_OSERR
        : EX_SOFTWARE,
    );
  }

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    host.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  startupComplete = true;

  await host.finished;
}
