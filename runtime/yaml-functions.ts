import { parse as parseYaml } from "yaml";
import type {
  EdgeConnectorHttpRequest,
  EdgeConnectorHttpResponse,
} from "./generated/models.ts";
import { RuntimeError } from "./runtime-error.ts";

export type YamlRequestTransformConfig = {
  headers?: {
    add?: Record<string, string>;
    remove?: string[];
    set?: Record<string, string>;
  };
  url?: {
    prefix?: string;
    suffix?: string;
    rewrite?: string;
    removePrefix?: string;
  };
  body?: {
    set?: string;
  };
  reject?: {
    if?: string;
    code?: string;
    message?: string;
  };
};

export type YamlResponseTransformConfig = {
  headers?: {
    add?: Record<string, string>;
    remove?: string[];
    set?: Record<string, string>;
  };
  body?: {
    set?: string;
  };
  statusCode?: {
    set?: number;
  };
};

export type YamlTransformContext = {
  requestId: string;
  startedAt: string;
  request: EdgeConnectorHttpRequest;
  env: Record<string, string>;
};

export type YamlFunctionConfig = {
  /** Target URL for upstream requests. Supports template interpolation. */
  target: string;
  /** Optional: Restrict to specific HTTP methods. Default: all methods. */
  methods?: string[];
  /** Request transformation config. */
  request?: YamlRequestTransformConfig;
  /** Response transformation config. */
  response?: YamlResponseTransformConfig;
  /** Timeout in milliseconds. Default: 30000. */
  timeout?: number;
};

export type YamlFunctionContext = {
  requestId: string;
  startedAt: string;
  env: Record<string, string>;
  method: string;
  url: URL;
  headers: Headers;
  body: string | null;
  params: Record<string, string>;
};

export function parseYamlFunctionConfig(
  content: string,
  path: string,
): YamlFunctionConfig {
  try {
    return parseYaml(content) as YamlFunctionConfig;
  } catch (error) {
    throw new RuntimeError(
      "YAML_PARSE_ERROR",
      `Failed to parse YAML function config at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

export function applyYamlRequestTransform(
  config: YamlRequestTransformConfig,
  request: EdgeConnectorHttpRequest,
  context: YamlTransformContext,
): EdgeConnectorHttpRequest {
  const result = { ...request, headers: { ...request.headers } };
  const evalContext: YamlTransformContext = { ...context, request };

  if (config.reject?.if) {
    const shouldReject = evaluateCondition(config.reject.if, evalContext);
    if (shouldReject) {
      throw new RuntimeError(
        config.reject.code ?? "REQUEST_REJECTED",
        interpolate(
          config.reject.message ?? "Request rejected by YAML function",
          evalContext,
        ),
      );
    }
  }

  if (config.headers) {
    result.headers = applyHeaderTransforms(
      result.headers ?? {},
      config.headers,
      evalContext,
    );
  }

  if (config.url) {
    result.url = applyUrlTransforms(result.url, config.url, evalContext);
  }

  if (config.body?.set !== undefined) {
    result.body = interpolate(config.body.set, evalContext);
  }

  return result;
}

export function applyYamlResponseTransform(
  config: YamlResponseTransformConfig,
  response: EdgeConnectorHttpResponse,
  context: YamlTransformContext,
): EdgeConnectorHttpResponse {
  const result = { ...response, headers: { ...response.headers } };

  if (config.headers) {
    result.headers = applyHeaderTransforms(
      result.headers ?? {},
      config.headers,
      context,
    );
  }

  if (config.body?.set !== undefined) {
    result.body = interpolate(config.body.set, context);
  }

  if (config.statusCode?.set !== undefined) {
    result.statusCode = config.statusCode.set;
  }

  return result;
}

type HeaderTransformConfig = {
  add?: Record<string, string>;
  remove?: string[];
  set?: Record<string, string>;
};

function applyHeaderTransforms(
  headers: NonNullable<EdgeConnectorHttpRequest["headers"]>,
  config: HeaderTransformConfig,
  context: YamlTransformContext,
): NonNullable<EdgeConnectorHttpRequest["headers"]> {
  const result = { ...headers };

  if (config.remove) {
    for (const name of config.remove) {
      const lowerName = name.toLowerCase();
      for (const key of Object.keys(result)) {
        if (key.toLowerCase() === lowerName) {
          delete result[key];
        }
      }
    }
  }

  if (config.set) {
    for (const [name, value] of Object.entries(config.set)) {
      const interpolatedValue = interpolate(value, context);
      result[name] = [interpolatedValue];
    }
  }

  if (config.add) {
    for (const [name, value] of Object.entries(config.add)) {
      const interpolatedValue = interpolate(value, context);
      const existing = result[name] ?? [];
      result[name] = [...existing, interpolatedValue];
    }
  }

  return result;
}

type UrlTransformConfig = {
  prefix?: string;
  suffix?: string;
  rewrite?: string;
  removePrefix?: string;
};

function applyUrlTransforms(
  url: string,
  config: UrlTransformConfig,
  context: YamlTransformContext,
): string {
  let result = url;

  if (config.removePrefix) {
    const prefix = interpolate(config.removePrefix, context);
    if (result.startsWith(prefix)) {
      result = result.slice(prefix.length);
    }
  }

  if (config.rewrite) {
    result = interpolate(config.rewrite, context);
  } else {
    if (config.prefix) {
      result = interpolate(config.prefix, context) + result;
    }

    if (config.suffix) {
      result = result + interpolate(config.suffix, context);
    }
  }

  return result;
}

export function interpolate(
  template: string,
  context: YamlTransformContext,
): string {
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, expr: string) => {
    const trimmed = expr.trim();
    return resolveExpression(trimmed, context);
  });
}

function resolveExpression(
  expr: string,
  context: YamlTransformContext,
): string {
  const parts = expr.split(".");

  if (parts[0] === "env" && parts.length === 2) {
    return context.env[parts[1]] ?? "";
  }

  if (parts[0] === "context") {
    if (parts[1] === "requestId") return context.requestId;
    if (parts[1] === "startedAt") return context.startedAt;
  }

  if (parts[0] === "request") {
    if (parts[1] === "url") return context.request.url;
    if (parts[1] === "method") return context.request.method;
    if (parts[1] === "body") return context.request.body ?? "";
  }

  return "";
}

function evaluateCondition(
  condition: string,
  context: YamlTransformContext,
): boolean {
  const containsMatch = condition.match(/^(.+?)\s+contains\s+"([^"]+)"$/);
  if (containsMatch) {
    const value = resolveExpression(containsMatch[1].trim(), context);
    return value.includes(containsMatch[2]);
  }

  const equalsMatch = condition.match(/^(.+?)\s*==\s*"([^"]*)"$/);
  if (equalsMatch) {
    const value = resolveExpression(equalsMatch[1].trim(), context);
    return value === equalsMatch[2];
  }

  const notEqualsMatch = condition.match(/^(.+?)\s*!=\s*"([^"]*)"$/);
  if (notEqualsMatch) {
    const value = resolveExpression(notEqualsMatch[1].trim(), context);
    return value !== notEqualsMatch[2];
  }

  const startsWithMatch = condition.match(/^(.+?)\s+startsWith\s+"([^"]+)"$/);
  if (startsWithMatch) {
    const value = resolveExpression(startsWithMatch[1].trim(), context);
    return value.startsWith(startsWithMatch[2]);
  }

  const endsWithMatch = condition.match(/^(.+?)\s+endsWith\s+"([^"]+)"$/);
  if (endsWithMatch) {
    const value = resolveExpression(endsWithMatch[1].trim(), context);
    return value.endsWith(endsWithMatch[2]);
  }

  return false;
}

export function createYamlFunctionHandler(
  config: YamlFunctionConfig,
  filePath: string,
): (ctx: YamlFunctionContext) => Promise<Response> {
  return async (ctx: YamlFunctionContext): Promise<Response> => {
    const internalHeaders: Record<string, string[]> = {};
    ctx.headers.forEach((value, name) => {
      if (!internalHeaders[name]) {
        internalHeaders[name] = [];
      }
      internalHeaders[name].push(value);
    });

    let internalRequest: EdgeConnectorHttpRequest = {
      method: ctx.method as EdgeConnectorHttpRequest["method"],
      url: ctx.url.pathname + ctx.url.search,
      headers: internalHeaders,
      body: ctx.body,
    };

    const transformContext: YamlTransformContext = {
      requestId: ctx.requestId,
      startedAt: ctx.startedAt,
      request: internalRequest,
      env: ctx.env,
    };

    if (config.request) {
      internalRequest = applyYamlRequestTransform(
        config.request,
        internalRequest,
        transformContext,
      );
    }

    const targetBase = interpolate(config.target, transformContext);
    if (!targetBase) {
      throw new RuntimeError(
        "CONFIG_ERROR",
        `YAML function at ${filePath}: target URL is empty after interpolation`,
      );
    }

    const targetUrl = new URL(internalRequest.url, targetBase);
    const outgoingHeaders = new Headers();
    if (internalRequest.headers) {
      for (const [name, values] of Object.entries(internalRequest.headers)) {
        for (const value of values) {
          outgoingHeaders.append(name, value);
        }
      }
    }

    outgoingHeaders.delete("host");
    outgoingHeaders.delete("connection");
    outgoingHeaders.delete("keep-alive");
    outgoingHeaders.delete("transfer-encoding");

    const timeout = config.timeout ?? 30000;
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(targetUrl.href, {
        method: internalRequest.method,
        headers: outgoingHeaders,
        body: internalRequest.body ?? undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new RuntimeError(
          "TIMEOUT",
          `Request to ${targetBase} timed out after ${timeout}ms`,
        );
      }
      throw new RuntimeError(
        "TARGET_REQUEST_ERROR",
        `Failed to request YAML function target ${targetBase}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const responseHeaders: Record<string, string[]> = {};
    upstreamResponse.headers.forEach((value, name) => {
      if (!responseHeaders[name]) {
        responseHeaders[name] = [];
      }
      responseHeaders[name].push(value);
    });

    let internalResponse: EdgeConnectorHttpResponse = {
      statusCode: upstreamResponse.status,
      headers: responseHeaders,
      body: await upstreamResponse.text(),
    };

    if (config.response) {
      internalResponse = applyYamlResponseTransform(
        config.response,
        internalResponse,
        { ...transformContext, request: internalRequest },
      );
    }

    const finalHeaders = new Headers();
    if (internalResponse.headers) {
      for (const [name, values] of Object.entries(internalResponse.headers)) {
        for (const value of values) {
          finalHeaders.append(name, value);
        }
      }
    }

    return new Response(internalResponse.body, {
      status: internalResponse.statusCode,
      headers: finalHeaders,
    });
  };
}
