import { environmentSnapshot } from "./environment.ts";
import type { ConnectorConfig } from "./config.ts";
import type { ProtocolExecutor } from "./connector.ts";
import { HttpFunctionRouter } from "./function-router.ts";
import {
  HttpFunctionScanner,
  type RegisteredHttpRoute,
} from "./function-scanner.ts";
import type { RuntimeLogger } from "./logger.ts";
import { createLogger } from "./logger.ts";
import { HttpProxyExecutor } from "./proxy-router.ts";

export type RoutingMode = "http-functions" | "http-proxy";

export type ReloadableProtocolExecutorOptions = {
  config: ConnectorConfig;
  env?: Record<string, string>;
  logger?: RuntimeLogger;
};

export class ReloadableProtocolExecutor implements ProtocolExecutor {
  private readonly config: ConnectorConfig;
  private readonly env: Record<string, string>;
  private readonly logger: RuntimeLogger;
  private delegate: ProtocolExecutor;
  private currentMode: RoutingMode = "http-proxy";
  private currentRoutes: readonly RegisteredHttpRoute[] = [];

  constructor(options: ReloadableProtocolExecutorOptions) {
    this.config = options.config;
    this.env = options.env ?? environmentSnapshot();
    this.logger = options.logger ?? createLogger(this.config.logLevel);
    this.delegate = new HttpProxyExecutor({ logger: this.logger });
  }

  get mode(): RoutingMode {
    return this.currentMode;
  }

  get routes(): readonly RegisteredHttpRoute[] {
    return this.currentRoutes;
  }

  async reload(reason = "manual"): Promise<void> {
    this.logger.info(
      `Composing routes (${reason}) from ${this.config.functionsDir}`,
    );

    const scanner = new HttpFunctionScanner({
      env: this.env,
      logger: this.logger,
    });
    await scanner.scan(this.config.functionsDir);

    if (scanner.routeCount > 0) {
      this.delegate = new HttpFunctionRouter({
        env: this.env,
        logger: this.logger,
        scanner,
      });
      this.currentMode = "http-functions";
      this.currentRoutes = scanner.getRoutes();
      this.logger.info(
        `HTTP function mode active with ${scanner.routeCount} route(s)`,
      );
      return;
    }

    this.delegate = new HttpProxyExecutor({ logger: this.logger });
    this.currentMode = "http-proxy";
    this.currentRoutes = [];
    this.logger.warn(
      "No HTTP function routes found; HTTP proxy mode active for absolute target URLs",
    );
  }

  execute: ProtocolExecutor["execute"] = (frame) => {
    return this.delegate.execute(frame);
  };
}

export async function createReloadableProtocolExecutor(
  options: ReloadableProtocolExecutorOptions,
): Promise<ReloadableProtocolExecutor> {
  const executor = new ReloadableProtocolExecutor(options);
  await executor.reload("startup");
  return executor;
}
