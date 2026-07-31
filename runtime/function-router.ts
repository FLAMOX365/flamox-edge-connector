/**
 * HTTP Function Router
 *
 * Routes incoming HTTP requests to function handlers.
 *
 * @module
 */

import { createHttpContext } from "../sdk/http.ts";
import type { ProtocolExecutor } from "./connector.ts";
import type { HttpFunctionScanner } from "./function-scanner.ts";
import type {
  EdgeConnectorHttpRequest,
  EdgeConnectorHttpResponse,
  EdgeConnectorRequestFrame,
} from "./generated/models.ts";
import type { RuntimeLogger } from "./logger.ts";
import { createLogger } from "./logger.ts";
import { RuntimeError } from "./runtime-error.ts";

/**
 * Options for creating an HttpFunctionRouter.
 */
export interface HttpFunctionRouterOptions {
  /** The function scanner with registered routes */
  scanner: HttpFunctionScanner;
  /** Environment variables to pass to handlers */
  env?: Record<string, string>;
  /** Runtime logger */
  logger?: RuntimeLogger;
}
/**
 * Routes HTTP requests to function handlers.
 */
export class HttpFunctionRouter implements ProtocolExecutor {
  private readonly scanner: HttpFunctionScanner;
  private readonly env: Record<string, string>;
  private readonly logger: RuntimeLogger;

  constructor(options: HttpFunctionRouterOptions) {
    this.scanner = options.scanner;
    this.env = options.env ?? Deno.env.toObject();
    this.logger = options.logger ?? createLogger();
  }

  /**
   * Execute an HTTP function handler for the given request frame.
   */
  async execute(
    frame: EdgeConnectorRequestFrame,
  ): Promise<EdgeConnectorHttpResponse> {
    const { request } = frame;

    // Build a standard Request object from EdgeConnectorHttpRequest
    const webRequest = this.buildWebRequest(request);

    // Match route
    const match = this.scanner.match(webRequest);

    if (!match) {
      // Check if route exists but method not allowed
      const pathname = new URL(webRequest.url).pathname;
      if (this.scanner.hasRoute(pathname)) {
        const allowed = this.scanner.getAllowedMethods(pathname);
        throw new RuntimeError(
          "METHOD_NOT_ALLOWED",
          `Method ${request.method} not allowed. Allowed: ${
            allowed.join(", ")
          }`,
        );
      }
      throw new RuntimeError(
        "NOT_FOUND",
        `No handler for ${request.method} ${pathname}`,
      );
    }

    this.logger.info(
      `Executing function route ${match.route.path} for ${request.method} ${request.url}`,
    );

    // Create handler context
    const ctx = createHttpContext({
      request: webRequest,
      params: match.params,
      env: this.env,
      requestId: frame.requestId,
      startedAt: new Date().toISOString(),
      log: this.logger,
      waitUntil: (task) => {
        void task.catch((error) => {
          this.logger.error("HTTP function background task failed", error);
        });
      },
    });

    // Execute handler
    const response = await match.handler(ctx);
    this.logger.debug(
      `Function route ${match.route.path} responded with ${response.status}`,
    );

    // Convert Response to EdgeConnectorHttpResponse
    return this.buildCloudResponse(response);
  }

  /**
   * Build a standard Request from EdgeConnectorHttpRequest.
   */
  private buildWebRequest(request: EdgeConnectorHttpRequest): Request {
    const headers = new Headers();
    if (request.headers) {
      for (const [name, values] of Object.entries(request.headers)) {
        for (const value of values) {
          headers.append(name, value);
        }
      }
    }

    // Build full URL (use localhost as base, path comes from request.url)
    const url = new URL(request.url, "http://localhost");

    return new Request(url.href, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body ?? undefined,
    });
  }

  /**
   * Build EdgeConnectorHttpResponse from a standard Response.
   */
  private async buildCloudResponse(
    response: Response,
  ): Promise<EdgeConnectorHttpResponse> {
    const headers: Record<string, string[]> = {};
    response.headers.forEach((value, name) => {
      if (!headers[name]) {
        headers[name] = [];
      }
      headers[name].push(value);
    });

    const body = await response.text();

    return {
      statusCode: response.status,
      headers,
      body: body || null,
    };
  }
}
