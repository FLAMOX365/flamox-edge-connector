/**
 * HTTP Proxy Executor
 *
 * Transparent pass-through used when no functions are present. Each inbound
 * request frame already carries the absolute target URL it should reach inside
 * the customer network, so the connector simply forwards the request 1:1 and
 * returns whatever the upstream responds. No configuration required.
 *
 * @module
 */

import type { ProtocolExecutor } from "./connector.ts";
import type {
  EdgeConnectorHttpResponse,
  EdgeConnectorRequestFrame,
} from "./generated/models.ts";
import type { RuntimeLogger } from "./logger.ts";
import { createLogger } from "./logger.ts";
import { RuntimeError } from "./runtime-error.ts";

export type HttpProxyExecutorOptions = {
  logger?: RuntimeLogger;
};

export class HttpProxyExecutor implements ProtocolExecutor {
  private readonly logger: RuntimeLogger;

  constructor(options: HttpProxyExecutorOptions = {}) {
    this.logger = options.logger ?? createLogger();
  }

  async execute(
    frame: EdgeConnectorRequestFrame,
  ): Promise<EdgeConnectorHttpResponse> {
    const { request } = frame;

    let targetUrl: URL;
    try {
      targetUrl = new URL(request.url);
    } catch {
      throw new RuntimeError(
        "INVALID_TARGET",
        `Proxy mode requires an absolute request URL, received "${request.url}"`,
      );
    }

    const headers = new Headers();
    if (request.headers) {
      for (const [name, values] of Object.entries(request.headers)) {
        for (const value of values) {
          headers.append(name, value);
        }
      }
    }
    // Host is derived from the target URL by fetch.
    headers.delete("host");

    this.logger.info(`Proxying ${request.method} ${targetUrl.href}`);

    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : (request.body ?? undefined),
    });

    const responseHeaders: Record<string, string[]> = {};
    response.headers.forEach((value, name) => {
      (responseHeaders[name] ??= []).push(value);
    });
    const body = await response.text();
    this.logger.debug(
      `Proxy response ${response.status} from ${targetUrl.href}`,
    );

    return {
      statusCode: response.status,
      headers: responseHeaders,
      body: body || null,
    };
  }
}
