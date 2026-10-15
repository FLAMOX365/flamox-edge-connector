/**
 * HTTP SDK for Edge Connector functions.
 *
 * This module exposes two equal public styles:
 * - functional: defineHttp({ get() { ... } }) and top-level response helpers
 * - fluent: http().get((ctx) => ctx.res.ok().json(...))
 *
 * Internally both styles produce the same HTTP route definition for the runtime.
 * Future protocol-specific SDKs should follow this shape instead of extending
 * HTTP-only request/response types.
 *
 * @module
 */

import { RuntimeError } from "./errors.ts";
import type { HttpMethod } from "./types.ts";

/**
 * HTTP methods that can be registered by Edge Connector HTTP functions.
 */
export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const satisfies readonly HttpMethod[];

/**
 * Logger shape exposed on {@link HttpContext.log}.
 */
export type ContextLogger = Pick<Console, "debug" | "error" | "info" | "warn">;

/**
 * Return value accepted from an HTTP handler or middleware callback.
 */
export type HttpHandlerResult = Response | Promise<Response>;

/**
 * Handles one incoming HTTP request and returns a Fetch API {@link Response}.
 */
export type HttpHandler = (ctx: HttpContext) => HttpHandlerResult;

/**
 * Continues execution with the next middleware or final handler in the pipeline.
 */
export type HttpNext = () => HttpHandlerResult;

/**
 * Wraps an HTTP handler to add cross-cutting behavior such as authentication,
 * logging, validation, or response decoration.
 */
export type HttpMiddleware = (
  ctx: HttpContext,
  next: HttpNext,
) => HttpHandlerResult;

/**
 * Converts an error thrown by a handler or middleware into an HTTP response.
 */
export type HttpErrorHandler = (
  error: unknown,
  ctx: HttpContext,
) => HttpHandlerResult;

/**
 * Runtime-consumable HTTP route definition produced by the functional or fluent
 * SDK APIs.
 */
export type HttpRouteDefinition = {
  /**
   * Protocol discriminator used by the runtime scanner.
   */
  readonly protocol: "http";

  /**
   * Method-specific handlers registered for this function file.
   */
  readonly handlers: Partial<Record<HttpMethod, HttpHandler>>;
};

type LowerHttpMethod = Lowercase<HttpMethod>;

export type DefineHttpConfig = Partial<Record<LowerHttpMethod, HttpHandler>> &
  Partial<Record<HttpMethod, HttpHandler>> & {
    /**
     * Handler registered for every supported HTTP method unless a
     * method-specific handler overwrites it.
     */
    all?: HttpHandler;

    /**
     * Error handler used for exceptions thrown by middleware or handlers.
     */
    onError?: HttpErrorHandler;

    /**
     * Middleware functions executed before the selected method handler.
     */
    use?: HttpMiddleware[];
  };

/**
 * Defines an HTTP function using the functional SDK style.
 *
 * @param config - Method handlers, optional middleware, and optional error
 * handling for the route.
 * @returns A route definition that can be exported from a function file.
 */
export function defineHttp(config: DefineHttpConfig): HttpRouteDefinition {
  const handlers: Partial<Record<HttpMethod, HttpHandler>> = {};
  const middleware = config.use ?? [];

  const register = (method: HttpMethod, handler: HttpHandler): void => {
    handlers[method] = (ctx) =>
      runHttpPipeline(ctx, handler, middleware, config.onError);
  };

  if (config.all) {
    for (const method of HTTP_METHODS) {
      register(method, config.all);
    }
  }

  for (const method of HTTP_METHODS) {
    const lowerMethod = method.toLowerCase() as LowerHttpMethod;
    const handler = config[lowerMethod] ?? config[method];
    if (handler) {
      register(method, handler);
    }
  }

  return { protocol: "http", handlers };
}

/**
 * Fluent builder interface with compile-time tracking of registered methods.
 *
 * After registering a handler for a method (e.g. `.get()`), that method is
 * removed from the available methods on the returned type. This prevents
 * accidental double-registration at compile time.
 */
export type HttpBuilderChain<Used extends HttpMethod = never> =
  HttpRouteDefinition & {
    /**
     * Adds middleware to the route pipeline.
     */
    use(middleware: HttpMiddleware): HttpBuilderChain<Used>;
    /**
     * Registers an error handler for middleware and method handlers.
     */
    onError(handler: HttpErrorHandler): HttpBuilderChain<Used>;
    /**
     * Registers one handler for all supported HTTP methods.
     * After calling `all()`, no individual method handlers can be registered.
     */
    all(handler: HttpHandler): HttpBuilderChain<HttpMethod>;
  } & ("GET" extends Used
      ? unknown
      : {
          /** Registers a handler for GET requests. */
          get(handler: HttpHandler): HttpBuilderChain<Used | "GET">;
        }) &
    ("POST" extends Used
      ? unknown
      : {
          /** Registers a handler for POST requests. */
          post(handler: HttpHandler): HttpBuilderChain<Used | "POST">;
        }) &
    ("PUT" extends Used
      ? unknown
      : {
          /** Registers a handler for PUT requests. */
          put(handler: HttpHandler): HttpBuilderChain<Used | "PUT">;
        }) &
    ("PATCH" extends Used
      ? unknown
      : {
          /** Registers a handler for PATCH requests. */
          patch(handler: HttpHandler): HttpBuilderChain<Used | "PATCH">;
        }) &
    ("DELETE" extends Used
      ? unknown
      : {
          /** Registers a handler for DELETE requests. */
          delete(handler: HttpHandler): HttpBuilderChain<Used | "DELETE">;
        }) &
    ("HEAD" extends Used
      ? unknown
      : {
          /** Registers a handler for HEAD requests. */
          head(handler: HttpHandler): HttpBuilderChain<Used | "HEAD">;
        }) &
    ("OPTIONS" extends Used
      ? unknown
      : {
          /** Registers a handler for OPTIONS requests. */
          options(handler: HttpHandler): HttpBuilderChain<Used | "OPTIONS">;
        });

/**
 * Starts a fluent HTTP route definition.
 *
 * @returns A mutable route builder that can register method handlers and
 * middleware through chained calls.
 */
export function http(): HttpBuilderChain {
  return new HttpRouteBuilder() as HttpBuilderChain;
}

/**
 * Checks whether an unknown value is an HTTP route definition understood by the
 * runtime.
 *
 * @param value - Value to inspect.
 * @returns `true` when the value contains the HTTP protocol discriminator and a
 * handler map.
 */
export function isHttpRouteDefinition(
  value: unknown,
): value is HttpRouteDefinition {
  return (
    isRecord(value) && value.protocol === "http" && isRecord(value.handlers)
  );
}

/**
 * Fluent builder for HTTP route definitions.
 *
 * Use this class through {@link http} in function files. Each method registers a
 * handler for the matching HTTP method and returns the same builder for chaining.
 */
export class HttpRouteBuilder implements HttpRouteDefinition {
  /**
   * Protocol discriminator used by the runtime scanner.
   */
  readonly protocol = "http";

  /**
   * Method-specific handlers registered on this builder.
   */
  readonly handlers: Partial<Record<HttpMethod, HttpHandler>> = {};
  private readonly middleware: HttpMiddleware[] = [];
  private errorHandler: HttpErrorHandler | undefined;

  /**
   * Adds middleware to the route pipeline.
   *
   * Middleware runs in registration order before the selected method handler.
   *
   * @param middleware - Middleware callback to add.
   * @returns This builder for chaining.
   */
  use(middleware: HttpMiddleware): this {
    this.middleware.push(middleware);
    return this;
  }

  /**
   * Registers an error handler for middleware and method handlers.
   *
   * @param handler - Callback that converts thrown errors into responses.
   * @returns This builder for chaining.
   */
  onError(handler: HttpErrorHandler): this {
    this.errorHandler = handler;
    return this;
  }

  /**
   * Registers one handler for all supported HTTP methods.
   *
   * @param handler - Handler to run for every HTTP method.
   * @returns This builder for chaining.
   */
  all(handler: HttpHandler): this {
    for (const method of HTTP_METHODS) {
      this.register(method, handler);
    }
    return this;
  }

  /**
   * Registers a handler for GET requests.
   *
   * @param handler - Handler to run for GET requests.
   * @returns This builder for chaining.
   */
  get(handler: HttpHandler): this {
    return this.register("GET", handler);
  }

  /**
   * Registers a handler for POST requests.
   *
   * @param handler - Handler to run for POST requests.
   * @returns This builder for chaining.
   */
  post(handler: HttpHandler): this {
    return this.register("POST", handler);
  }

  /**
   * Registers a handler for PUT requests.
   *
   * @param handler - Handler to run for PUT requests.
   * @returns This builder for chaining.
   */
  put(handler: HttpHandler): this {
    return this.register("PUT", handler);
  }

  /**
   * Registers a handler for PATCH requests.
   *
   * @param handler - Handler to run for PATCH requests.
   * @returns This builder for chaining.
   */
  patch(handler: HttpHandler): this {
    return this.register("PATCH", handler);
  }

  /**
   * Registers a handler for DELETE requests.
   *
   * @param handler - Handler to run for DELETE requests.
   * @returns This builder for chaining.
   */
  delete(handler: HttpHandler): this {
    return this.register("DELETE", handler);
  }

  /**
   * Registers a handler for HEAD requests.
   *
   * @param handler - Handler to run for HEAD requests.
   * @returns This builder for chaining.
   */
  head(handler: HttpHandler): this {
    return this.register("HEAD", handler);
  }

  /**
   * Registers a handler for OPTIONS requests.
   *
   * @param handler - Handler to run for OPTIONS requests.
   * @returns This builder for chaining.
   */
  options(handler: HttpHandler): this {
    return this.register("OPTIONS", handler);
  }

  private register(method: HttpMethod, handler: HttpHandler): this {
    if (this.handlers[method]) {
      throw new RuntimeError(
        "DUPLICATE_HANDLER",
        `Handler for ${method} already registered. Each HTTP method can only have one handler per route file.`,
      );
    }
    this.handlers[method] = (ctx) =>
      runHttpPipeline(ctx, handler, this.middleware, this.errorHandler);
    return this;
  }
}

async function runHttpPipeline(
  ctx: HttpContext,
  handler: HttpHandler,
  middleware: readonly HttpMiddleware[],
  errorHandler: HttpErrorHandler | undefined,
): Promise<Response> {
  let index = -1;

  const dispatch = async (position: number): Promise<Response> => {
    if (position <= index) {
      throw new RuntimeError(
        "MIDDLEWARE_ERROR",
        "HTTP middleware called next() more than once",
      );
    }

    index = position;
    const current = middleware[position];
    if (!current) {
      return await handler(ctx);
    }

    return await current(ctx, () => dispatch(position + 1));
  };

  try {
    return await dispatch(0);
  } catch (error) {
    if (errorHandler) {
      return await errorHandler(error, ctx);
    }
    throw error;
  }
}

/**
 * Request context passed to every HTTP handler and middleware callback.
 */
export interface HttpContext {
  /**
   * Protocol discriminator for HTTP request contexts.
   */
  readonly protocol: "http";

  /**
   * Request facade with route parameters, query values, headers, cookies, and
   * body helpers.
   */
  readonly req: HttpRequestFacade;

  /**
   * Response factory for common success and error responses.
   */
  readonly res: HttpResponseFactory;

  /**
   * Proxy builder bound to the current request.
   */
  readonly proxy: HttpProxyBuilder;

  /**
   * Environment variables available to the function.
   */
  readonly env: Readonly<Record<string, string>>;

  /**
   * Unique request identifier propagated through helpers and upstream calls.
   */
  readonly requestId: string;

  /**
   * ISO timestamp captured when the runtime started processing the request.
   */
  readonly startedAt: string;

  /**
   * Logger provided by the runtime for request-scoped diagnostics.
   */
  readonly log: ContextLogger;

  /**
   * Creates an upstream request builder with the current request id already
   * attached as an `x-request-id` header.
   *
   * @param baseUrl - Base URL for the upstream service.
   * @returns A fluent upstream request builder.
   */
  upstream(baseUrl: string | URL): HttpUpstreamBuilder;

  /**
   * Registers background work that should be observed after the response is
   * returned.
   *
   * @param task - Promise representing the background work.
   */
  waitUntil(task: Promise<unknown>): void;
}

/**
 * Options used by the runtime to create an {@link HttpContext}.
 */
export interface CreateHttpContextOptions {
  /**
   * Original Fetch API request received by the runtime.
   */
  request: Request;

  /**
   * Route parameters extracted from the function file path.
   */
  params: Record<string, string>;

  /**
   * Environment variables available to the function.
   */
  env: Record<string, string>;

  /**
   * Unique request identifier for this invocation.
   */
  requestId: string;

  /**
   * ISO timestamp captured at the start of request processing.
   */
  startedAt: string;

  /**
   * Optional logger. Defaults to `console`.
   */
  log?: ContextLogger;

  /**
   * Optional background-task registration hook.
   */
  waitUntil?: (task: Promise<unknown>) => void;
}

/**
 * Creates the HTTP handler context used by the runtime.
 *
 * Most function authors receive this object as the `ctx` handler argument and do
 * not need to call this helper directly.
 *
 * @param options - Raw request data and runtime services.
 * @returns A complete HTTP request context.
 */
export function createHttpContext(
  options: CreateHttpContextOptions,
): HttpContext {
  const log = options.log ?? console;
  const req = new HttpRequestFacade(options.request, options.params);
  const res = new HttpResponseFactory(req.method);
  const context = {} as Mutable<HttpContext>;

  context.protocol = "http";
  context.req = req;
  context.res = res;
  context.env = Object.freeze({ ...options.env });
  context.requestId = options.requestId;
  context.startedAt = options.startedAt;
  context.log = log;
  context.upstream = (baseUrl) =>
    new HttpUpstreamBuilder(baseUrl).header("x-request-id", options.requestId);
  context.waitUntil =
    options.waitUntil ??
    ((task) => {
      void task.catch((error) => log.error("Background task failed", error));
    });
  context.proxy = new HttpProxyBuilder(context);

  return context;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Read-only facade around the incoming Fetch API request.
 */
export class HttpRequestFacade {
  /**
   * Route parameters extracted from the matched function path.
   */
  readonly params: HttpParamsFacade;

  /**
   * Query-string helpers for the request URL.
   */
  readonly query: HttpQueryFacade;

  /**
   * Body helpers that safely reuse the request body stream.
   */
  readonly body: HttpRequestBodyFacade;

  /**
   * Original Fetch API request.
   */
  readonly raw: Request;
  private readonly cookieJar: Lazy<Record<string, string>>;
  private readonly urlValue: URL;

  /**
   * Creates a request facade for runtime and test usage.
   *
   * @param raw - Original Fetch API request.
   * @param params - Route parameters extracted from the function path.
   */
  constructor(raw: Request, params: Record<string, string>) {
    this.raw = raw;
    this.urlValue = new URL(raw.url);
    this.params = new HttpParamsFacade(params);
    this.query = new HttpQueryFacade(this.urlValue.searchParams);
    this.body = new HttpRequestBodyFacade(raw);
    this.cookieJar = new Lazy(() =>
      parseCookieHeader(raw.headers.get("cookie")),
    );
  }

  /**
   * HTTP method normalized to the SDK's supported method union.
   */
  get method(): HttpMethod {
    return this.raw.method.toUpperCase() as HttpMethod;
  }

  /**
   * Copy of the request URL.
   */
  get url(): URL {
    return new URL(this.urlValue.href);
  }

  /**
   * URL pathname without the query string.
   */
  get path(): string {
    return this.urlValue.pathname;
  }

  /**
   * Raw URL search string, including the leading `?` when present.
   */
  get search(): string {
    return this.urlValue.search;
  }

  /**
   * Request headers from the original Fetch API request.
   */
  get headers(): Headers {
    return this.raw.headers;
  }

  /**
   * Reads one request header by name.
   *
   * @param name - Header name to read.
   * @returns The header value, or `null` when the header is absent.
   */
  header(name: string): string | null {
    return this.raw.headers.get(name);
  }

  /**
   * Reads one cookie from the `Cookie` header.
   *
   * @param name - Cookie name to read.
   * @returns The decoded cookie value, or `undefined` when it is absent.
   */
  cookie(name: string): string | undefined {
    return this.cookieJar.value[name];
  }

  /**
   * Reads all cookies from the `Cookie` header.
   *
   * @returns An immutable copy of decoded cookie name/value pairs.
   */
  cookies(): Readonly<Record<string, string>> {
    return Object.freeze({ ...this.cookieJar.value });
  }
}

/**
 * Accessor for route parameters extracted from file-system route segments.
 */
export class HttpParamsFacade {
  /**
   * Creates a route-parameter facade.
   *
   * @param values - Parameter values keyed by route parameter name.
   */
  constructor(private readonly values: Readonly<Record<string, string>>) {}

  /**
   * Reads an optional route parameter.
   *
   * @param name - Parameter name to read.
   * @returns The parameter value, or `undefined` when it is absent.
   */
  get(name: string): string | undefined {
    return this.values[name];
  }

  /**
   * Reads a required route parameter.
   *
   * @param name - Parameter name to read.
   * @returns The parameter value.
   * @throws {@link RuntimeError} when the parameter is missing or empty.
   */
  require(name: string): string {
    const value = this.get(name);
    if (value === undefined || value === "") {
      throw new RuntimeError(
        "MISSING_PARAMETER",
        `Missing required route parameter "${name}"`,
      );
    }
    return value;
  }

  /**
   * Returns all route parameters.
   *
   * @returns The route parameter map used by this facade.
   */
  all(): Readonly<Record<string, string>> {
    return this.values;
  }
}

/**
 * Accessor for query-string values with typed parsing helpers.
 */
export class HttpQueryFacade {
  /**
   * Creates a query facade.
   *
   * @param values - URL search parameters to expose.
   */
  constructor(private readonly values: URLSearchParams) {}

  /**
   * Reads the first value for a query parameter.
   *
   * @param name - Query parameter name.
   * @returns The parameter value, or `undefined` when it is absent.
   */
  get(name: string): string | undefined {
    return this.values.get(name) ?? undefined;
  }

  /**
   * Reads all values for a repeated query parameter.
   *
   * @param name - Query parameter name.
   * @returns All values in URL order.
   */
  all(name: string): string[] {
    return this.values.getAll(name);
  }

  /**
   * Checks whether a query parameter exists.
   *
   * @param name - Query parameter name.
   * @returns `true` when at least one value is present.
   */
  has(name: string): boolean {
    return this.values.has(name);
  }

  /**
   * Parses a query parameter as an integer.
   *
   * @param name - Query parameter name.
   * @param fallback - Value returned when the parameter is absent or empty.
   * @returns The parsed integer or the fallback value.
   * @throws {@link RuntimeError} when the value is not an integer.
   */
  int(name: string, fallback?: number): number | undefined {
    const value = this.get(name);
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      throw new RuntimeError(
        "INVALID_QUERY_PARAMETER",
        `Query parameter "${name}" must be an integer`,
      );
    }
    return parsed;
  }

  /**
   * Parses a query parameter as a finite number.
   *
   * @param name - Query parameter name.
   * @param fallback - Value returned when the parameter is absent or empty.
   * @returns The parsed number or the fallback value.
   * @throws {@link RuntimeError} when the value is not a finite number.
   */
  number(name: string, fallback?: number): number | undefined {
    const value = this.get(name);
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new RuntimeError(
        "INVALID_QUERY_PARAMETER",
        `Query parameter "${name}" must be a number`,
      );
    }
    return parsed;
  }

  /**
   * Parses a query parameter as a boolean.
   *
   * Accepted true values are `1`, `true`, `yes`, and `on`. Accepted false
   * values are `0`, `false`, `no`, and `off`.
   *
   * @param name - Query parameter name.
   * @param fallback - Value returned when the parameter is absent or empty.
   * @returns The parsed boolean or the fallback value.
   * @throws {@link RuntimeError} when the value is not a recognized boolean.
   */
  boolean(name: string, fallback?: boolean): boolean | undefined {
    const value = this.get(name);
    if (value === undefined || value === "") return fallback;
    if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
    if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
    throw new RuntimeError(
      "INVALID_QUERY_PARAMETER",
      `Query parameter "${name}" must be a boolean`,
    );
  }

  /**
   * Iterates over all query parameter entries.
   *
   * @returns An iterator over `[name, value]` pairs in URL order.
   */
  entries(): IterableIterator<[string, string]> {
    return this.values.entries();
  }

  /**
   * Creates a mutable copy of the underlying URL search parameters.
   *
   * @returns A new {@link URLSearchParams} instance.
   */
  toURLSearchParams(): URLSearchParams {
    return new URLSearchParams(this.values);
  }
}

/**
 * Body reader that caches the incoming request body so multiple helpers can be
 * used safely in one handler.
 */
export class HttpRequestBodyFacade {
  private arrayBufferPromise: Promise<ArrayBuffer> | undefined;
  private textPromise: Promise<string> | undefined;

  /**
   * Creates a body facade for an incoming request.
   *
   * @param request - Request whose body should be read.
   */
  constructor(private readonly request: Request) {}

  /**
   * Reads the request body as an {@link ArrayBuffer}.
   *
   * @returns A copy of the body bytes.
   */
  arrayBuffer(): Promise<ArrayBuffer> {
    this.arrayBufferPromise ??= this.request.arrayBuffer();
    return this.arrayBufferPromise.then((buffer) => buffer.slice(0));
  }

  /**
   * Reads the request body as UTF-8 text.
   *
   * @returns The decoded request body.
   */
  text(): Promise<string> {
    this.textPromise ??= this.arrayBuffer().then((buffer) =>
      new TextDecoder().decode(buffer),
    );
    return this.textPromise;
  }

  /**
   * Reads the request body as JSON.
   *
   * Empty bodies are returned as an empty object to keep optional JSON payloads
   * ergonomic.
   *
   * @typeParam T - Expected JSON value type.
   * @returns The parsed JSON value.
   * @throws {@link RuntimeError} when the body is not valid JSON.
   */
  async json<T = unknown>(): Promise<T> {
    const text = await this.text();
    if (text.trim() === "") {
      return {} as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new RuntimeError("INVALID_JSON", "Request body is not valid JSON", {
        cause: error,
      });
    }
  }

  /**
   * Reads the request body as multipart or form data.
   *
   * @returns Parsed {@link FormData}.
   */
  async formData(): Promise<FormData> {
    const request = new Request("http://localhost", {
      method: "POST",
      headers: this.request.headers,
      body: await this.arrayBuffer(),
    });
    return request.formData();
  }

  /**
   * Reads the request body as `application/x-www-form-urlencoded` data.
   *
   * @returns Parsed URL-encoded form values.
   */
  async urlEncoded(): Promise<URLSearchParams> {
    return new URLSearchParams(await this.text());
  }

  /**
   * Reads the request body based on its `content-type` header.
   *
   * JSON, URL-encoded form data, octet streams, and text payloads are handled
   * automatically.
   *
   * @typeParam T - Expected JSON value type when the body is JSON.
   * @returns Parsed body data matching the detected content type.
   */
  async auto<T = unknown>(): Promise<
    T | string | URLSearchParams | ArrayBuffer
  > {
    const contentType =
      this.request.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() ?? "text/plain";

    if (contentType === "application/json") return await this.json<T>();
    if (contentType === "application/x-www-form-urlencoded") {
      return await this.urlEncoded();
    }
    if (contentType === "application/octet-stream") {
      return await this.arrayBuffer();
    }
    return await this.text();
  }
}

class Lazy<T> {
  private initialized = false;
  private cached: T | undefined;

  constructor(private readonly create: () => T) {}

  get value(): T {
    if (!this.initialized) {
      this.cached = this.create();
      this.initialized = true;
    }
    return this.cached as T;
  }
}

/**
 * Factory for common HTTP responses.
 */
export class HttpResponseFactory {
  /**
   * Creates a response factory.
   *
   * @param requestMethod - Optional original request method, used to suppress
   * response bodies for HEAD requests.
   */
  constructor(private readonly requestMethod?: string) {}

  /**
   * Starts a response builder with a custom status code.
   *
   * @param statusCode - HTTP status code for the response.
   * @returns A response builder.
   */
  status(statusCode: number): HttpResponseBuilder {
    return new HttpResponseBuilder(statusCode, this.requestMethod);
  }

  /**
   * Starts a `200 OK` response builder.
   *
   * @returns A response builder using status 200.
   */
  ok(): HttpResponseBuilder {
    return this.status(200);
  }

  /**
   * Starts a `201 Created` response builder.
   *
   * @returns A response builder using status 201.
   */
  created(): HttpResponseBuilder {
    return this.status(201);
  }

  /**
   * Starts a `202 Accepted` response builder.
   *
   * @returns A response builder using status 202.
   */
  accepted(): HttpResponseBuilder {
    return this.status(202);
  }

  /**
   * Creates a `204 No Content` response.
   *
   * @returns A response without a body.
   */
  noContent(): Response {
    return this.status(204).empty();
  }

  /**
   * Creates a JSON response.
   *
   * @param data - Value serialized with `JSON.stringify`.
   * @param init - Optional status and headers.
   * @returns A response with `application/json; charset=utf-8` unless another
   * content type is provided.
   */
  json<T>(data: T, init?: ResponseInit): Response {
    return this.status(init?.status ?? 200)
      .headers(init?.headers)
      .json(data);
  }

  /**
   * Creates a plain-text response.
   *
   * @param data - Text body to send.
   * @param init - Optional status and headers.
   * @returns A response with `text/plain; charset=utf-8` unless another
   * content type is provided.
   */
  text(data: string, init?: ResponseInit): Response {
    return this.status(init?.status ?? 200)
      .headers(init?.headers)
      .text(data);
  }

  /**
   * Creates an HTML response.
   *
   * @param data - HTML body to send.
   * @param init - Optional status and headers.
   * @returns A response with `text/html; charset=utf-8` unless another content
   * type is provided.
   */
  html(data: string, init?: ResponseInit): Response {
    return this.status(init?.status ?? 200)
      .headers(init?.headers)
      .html(data);
  }

  /**
   * Creates a redirect response.
   *
   * @param url - Redirect target URL.
   * @param status - Redirect status code. Defaults to 307.
   * @returns A response with a `location` header and no body.
   */
  redirect(url: string | URL, status: RedirectStatus = 307): Response {
    return this.status(status).redirect(url);
  }

  /**
   * Creates a JSON error response using Edge Connector error envelope.
   *
   * @param statusCode - HTTP status code for the error response.
   * @param message - Human-readable error message.
   * @param code - Machine-readable error code. Defaults to the status code.
   * @returns A JSON response shaped as `{ error: { code, message } }`.
   */
  error(
    statusCode: number,
    message: string,
    code: string = String(statusCode),
  ): Response {
    return this.status(statusCode).json({ error: { code, message } });
  }

  /**
   * Creates a `400 Bad Request` error response.
   *
   * @param message - Human-readable error message.
   * @returns A JSON error response with code `BAD_REQUEST`.
   */
  badRequest(message: string): Response {
    return this.error(400, message, "BAD_REQUEST");
  }

  /**
   * Creates a `401 Unauthorized` error response.
   *
   * @param message - Human-readable error message.
   * @returns A JSON error response with code `UNAUTHORIZED`.
   */
  unauthorized(message = "Unauthorized"): Response {
    return this.error(401, message, "UNAUTHORIZED");
  }

  /**
   * Creates a `403 Forbidden` error response.
   *
   * @param message - Human-readable error message.
   * @returns A JSON error response with code `FORBIDDEN`.
   */
  forbidden(message = "Forbidden"): Response {
    return this.error(403, message, "FORBIDDEN");
  }

  /**
   * Creates a `404 Not Found` error response.
   *
   * @param message - Human-readable error message.
   * @returns A JSON error response with code `NOT_FOUND`.
   */
  notFound(message = "Not found"): Response {
    return this.error(404, message, "NOT_FOUND");
  }

  /**
   * Creates a `409 Conflict` error response.
   *
   * @param message - Human-readable error message.
   * @returns A JSON error response with code `CONFLICT`.
   */
  conflict(message = "Conflict"): Response {
    return this.error(409, message, "CONFLICT");
  }

  /**
   * Creates a `422 Unprocessable Entity` error response.
   *
   * @param message - Human-readable error message.
   * @returns A JSON error response with code `UNPROCESSABLE_ENTITY`.
   */
  unprocessableEntity(message: string): Response {
    return this.error(422, message, "UNPROCESSABLE_ENTITY");
  }

  /**
   * Creates a `500 Internal Server Error` error response.
   *
   * @param message - Human-readable error message.
   * @returns A JSON error response with code `INTERNAL_SERVER_ERROR`.
   */
  internalServerError(message = "Internal server error"): Response {
    return this.error(500, message, "INTERNAL_SERVER_ERROR");
  }

  /**
   * Starts a builder that forwards or transforms an existing response.
   *
   * @param response - Existing response to adapt.
   * @returns A response forwarding builder.
   */
  from(response: Response): HttpResponseFromBuilder {
    return new HttpResponseFromBuilder(response, this.requestMethod);
  }
}

/**
 * HTTP status codes allowed for redirect responses.
 */
export type RedirectStatus = 301 | 302 | 303 | 307 | 308;

/**
 * Options used when serializing a `Set-Cookie` response header.
 */
export type CookieOptions = {
  /**
   * Cookie domain attribute.
   */
  domain?: string;

  /**
   * Absolute expiration date for the cookie.
   */
  expires?: Date;

  /**
   * Adds the `HttpOnly` attribute when true.
   */
  httpOnly?: boolean;

  /**
   * Relative cookie lifetime in seconds.
   */
  maxAge?: number;

  /**
   * Cookie path attribute.
   */
  path?: string;

  /**
   * SameSite policy for the cookie.
   */
  sameSite?: "lax" | "strict" | "none";

  /**
   * Adds the `Secure` attribute when true.
   */
  secure?: boolean;
};

/**
 * Fluent builder for a single HTTP response.
 */
export class HttpResponseBuilder {
  private readonly headerValues = new Headers();

  /**
   * Creates a response builder.
   *
   * @param statusCode - Initial HTTP status code.
   * @param requestMethod - Optional original request method, used to suppress
   * response bodies for HEAD requests.
   */
  constructor(
    private statusCode: number,
    private readonly requestMethod?: string,
  ) {}

  /**
   * Replaces the response status code.
   *
   * @param statusCode - HTTP status code to use.
   * @returns This builder for chaining.
   */
  status(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }

  /**
   * Applies multiple response headers.
   *
   * @param headers - Headers to merge into the response.
   * @returns This builder for chaining.
   */
  headers(headers: HeadersInit | undefined): this {
    if (!headers) return this;
    new Headers(headers).forEach((value, name) =>
      this.headerValues.set(name, value),
    );
    return this;
  }

  /**
   * Sets one response header, replacing an existing value.
   *
   * @param name - Header name.
   * @param value - Header value.
   * @returns This builder for chaining.
   */
  header(name: string, value: string): this {
    this.headerValues.set(name, value);
    return this;
  }

  /**
   * Appends one response header value.
   *
   * @param name - Header name.
   * @param value - Header value to append.
   * @returns This builder for chaining.
   */
  appendHeader(name: string, value: string): this {
    this.headerValues.append(name, value);
    return this;
  }

  /**
   * Removes a response header.
   *
   * @param name - Header name to remove.
   * @returns This builder for chaining.
   */
  removeHeader(name: string): this {
    this.headerValues.delete(name);
    return this;
  }

  /**
   * Adds a `Set-Cookie` response header.
   *
   * @param name - Cookie name.
   * @param value - Cookie value.
   * @param options - Cookie serialization options.
   * @returns This builder for chaining.
   */
  cookie(name: string, value: string, options: CookieOptions = {}): this {
    this.headerValues.append(
      "set-cookie",
      serializeCookie(name, value, options),
    );
    return this;
  }

  /**
   * Sets the response `content-type` header.
   *
   * @param contentType - Content type header value.
   * @returns This builder for chaining.
   */
  type(contentType: string): this {
    return this.header("content-type", contentType);
  }

  /**
   * Finalizes the response with a JSON body.
   *
   * @param data - Value serialized with `JSON.stringify`.
   * @returns A Fetch API response.
   */
  json<T>(data: T): Response {
    if (!this.headerValues.has("content-type")) {
      this.type("application/json; charset=utf-8");
    }
    return this.finalize(JSON.stringify(data));
  }

  /**
   * Finalizes the response with a plain-text body.
   *
   * @param data - Text body to send.
   * @returns A Fetch API response.
   */
  text(data: string): Response {
    if (!this.headerValues.has("content-type")) {
      this.type("text/plain; charset=utf-8");
    }
    return this.finalize(data);
  }

  /**
   * Finalizes the response with an HTML body.
   *
   * @param data - HTML body to send.
   * @returns A Fetch API response.
   */
  html(data: string): Response {
    if (!this.headerValues.has("content-type")) {
      this.type("text/html; charset=utf-8");
    }
    return this.finalize(data);
  }

  /**
   * Finalizes the response by inferring the body format from the provided
   * value.
   *
   * Strings are sent as text, `null` and `undefined` produce an empty response,
   * existing {@link Response} objects are returned unchanged, and all other
   * values are sent as JSON.
   *
   * @param data - Value to send.
   * @returns A Fetch API response.
   */
  send(data: unknown): Response {
    if (data instanceof Response) return data;
    if (data === undefined || data === null) return this.empty();
    if (typeof data === "string") return this.text(data);
    if (typeof data === "number" || typeof data === "boolean") {
      return this.json(data);
    }
    return this.json(data);
  }

  /**
   * Finalizes the response without a body.
   *
   * @returns A Fetch API response with a `null` body.
   */
  empty(): Response {
    return this.finalize(null);
  }

  /**
   * Finalizes the response as a redirect.
   *
   * @param url - Redirect target URL.
   * @returns A Fetch API response with a `location` header.
   * @throws {@link RuntimeError} when the current status is not a redirect
   * status.
   */
  redirect(url: string | URL): Response {
    if (!isRedirectStatus(this.statusCode)) {
      throw new RuntimeError(
        "INVALID_REDIRECT",
        "Redirect responses must use status 301, 302, 303, 307, or 308",
      );
    }
    this.header("location", url.toString());
    return this.finalize(null);
  }

  private finalize(body: BodyInit | null): Response {
    const headers = new Headers(this.headerValues);
    const mustBeEmpty =
      this.statusCode === 204 ||
      this.statusCode === 304 ||
      this.requestMethod === "HEAD";

    if (mustBeEmpty) {
      headers.delete("content-type");
      headers.delete("content-length");
      headers.delete("transfer-encoding");
      body = null;
    }

    return new Response(body, {
      status: this.statusCode,
      headers,
    });
  }
}

/**
 * Builder for adapting an existing Fetch API response.
 */
export class HttpResponseFromBuilder {
  private readonly headers: Headers;
  private statusCode: number;

  /**
   * Creates a response forwarding builder.
   *
   * @param response - Existing response to adapt.
   * @param requestMethod - Optional original request method, used to suppress
   * response bodies for HEAD requests.
   */
  constructor(
    private readonly response: Response,
    private readonly requestMethod?: string,
  ) {
    this.headers = new Headers(response.headers);
    this.statusCode = response.status;
  }

  /**
   * Replaces the response status code.
   *
   * @param statusCode - HTTP status code to use.
   * @returns This builder for chaining.
   */
  status(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }

  /**
   * Sets one response header, replacing an existing value.
   *
   * @param name - Header name.
   * @param value - Header value.
   * @returns This builder for chaining.
   */
  header(name: string, value: string): this {
    this.headers.set(name, value);
    return this;
  }

  /**
   * Removes one response header.
   *
   * @param name - Header name to remove.
   * @returns This builder for chaining.
   */
  removeHeader(name: string): this {
    this.headers.delete(name);
    return this;
  }

  /**
   * Sends the adapted response body without reparsing it.
   *
   * @returns A new Fetch API response with the configured status and headers.
   */
  async send(): Promise<Response> {
    const body =
      this.requestMethod === "HEAD" ||
      this.statusCode === 204 ||
      this.statusCode === 304
        ? null
        : await this.response.text();
    return new Response(body, {
      status: this.statusCode,
      headers: this.headers,
    });
  }

  /**
   * Reads the adapted response as JSON and sends it through the JSON response
   * builder.
   *
   * @typeParam T - Expected JSON value type.
   * @returns A new JSON response with the configured status and headers.
   */
  async json<T = unknown>(): Promise<Response> {
    const data = (await this.response.json()) as T;
    return new HttpResponseBuilder(this.statusCode, this.requestMethod)
      .headers(this.headers)
      .json(data);
  }

  /**
   * Reads the adapted response as text and sends it through the text response
   * builder.
   *
   * @returns A new text response with the configured status and headers.
   */
  async text(): Promise<Response> {
    return new HttpResponseBuilder(this.statusCode, this.requestMethod)
      .headers(this.headers)
      .text(await this.response.text());
  }
}

/**
 * Fluent builder for outgoing HTTP requests to upstream services.
 */
export class HttpUpstreamBuilder {
  private readonly headers = new Headers();
  private readonly query = new URLSearchParams();
  private pathValue = "/";
  private bodyValue: BodyInit | undefined;
  private timeoutMs: number | undefined;

  /**
   * Creates an upstream request builder.
   *
   * @param baseUrl - Base URL used to resolve request paths.
   */
  constructor(private readonly baseUrl: string | URL) {}

  /**
   * Sets the request path, interpolating `{name}` placeholders from the params
   * object.
   *
   * @param template - Path template relative to the base URL.
   * @param params - Values used for `{name}` placeholders.
   * @returns This builder for chaining.
   * @throws {@link RuntimeError} when a required path parameter is missing.
   */
  path(template: string, params: Record<string, string | number> = {}): this {
    this.pathValue = interpolatePath(template, params);
    return this;
  }

  /**
   * Sets one query parameter.
   *
   * Undefined values are ignored.
   *
   * @param name - Query parameter name.
   * @param value - Query parameter value.
   * @returns This builder for chaining.
   */
  queryParam(name: string, value: string | number | boolean | undefined): this {
    if (value !== undefined) this.query.set(name, String(value));
    return this;
  }

  /**
   * Appends query parameters from another query container.
   *
   * @param values - Query facade or URL search parameters to copy from.
   * @returns This builder for chaining.
   */
  queryFrom(values: URLSearchParams | HttpQueryFacade): this {
    const entries =
      values instanceof HttpQueryFacade
        ? values.toURLSearchParams().entries()
        : values.entries();
    for (const [name, value] of entries) this.query.append(name, value);
    return this;
  }

  /**
   * Sets one request header, replacing an existing value.
   *
   * @param name - Header name.
   * @param value - Header value.
   * @returns This builder for chaining.
   */
  header(name: string, value: string): this {
    this.headers.set(name, value);
    return this;
  }

  /**
   * Applies multiple request headers.
   *
   * @param headers - Headers to merge into the upstream request.
   * @returns This builder for chaining.
   */
  headersFrom(headers: HeadersInit): this {
    new Headers(headers).forEach((value, name) =>
      this.headers.set(name, value),
    );
    return this;
  }

  /**
   * Sets a bearer authorization header when a token is provided.
   *
   * @param token - Bearer token. Undefined values are ignored.
   * @returns This builder for chaining.
   */
  bearer(token: string | undefined): this {
    if (token) this.header("authorization", `Bearer ${token}`);
    return this;
  }

  /**
   * Sets a basic-auth authorization header.
   *
   * @param username - Basic-auth username.
   * @param password - Basic-auth password.
   * @returns This builder for chaining.
   */
  basicAuth(username: string, password: string): this {
    return this.header(
      "authorization",
      `Basic ${btoa(`${username}:${password}`)}`,
    );
  }

  /**
   * Sets an upstream request timeout.
   *
   * @param ms - Timeout in milliseconds.
   * @returns This builder for chaining.
   */
  timeout(ms: number): this {
    this.timeoutMs = ms;
    return this;
  }

  /**
   * Sets the raw request body for non-GET and non-HEAD requests.
   *
   * @param body - Fetch API body value.
   * @returns This builder for chaining.
   */
  body(body: BodyInit | undefined): this {
    this.bodyValue = body;
    return this;
  }

  /**
   * Sets a JSON request body and `application/json` content type.
   *
   * @param data - Value serialized with `JSON.stringify`.
   * @returns This builder for chaining.
   */
  jsonBody(data: unknown): this {
    this.header("content-type", "application/json");
    this.bodyValue = JSON.stringify(data);
    return this;
  }

  /**
   * Sets a text request body and `text/plain; charset=utf-8` content type.
   *
   * @param data - Text body to send.
   * @returns This builder for chaining.
   */
  textBody(data: string): this {
    this.header("content-type", "text/plain; charset=utf-8");
    this.bodyValue = data;
    return this;
  }

  /**
   * Sends a GET request.
   *
   * @returns The upstream Fetch API response.
   */
  get(): Promise<Response> {
    return this.send("GET");
  }

  /**
   * Sends a POST request, optionally using the provided value as a JSON body.
   *
   * @param data - Optional JSON body value.
   * @returns The upstream Fetch API response.
   */
  post(data?: unknown): Promise<Response> {
    if (data !== undefined) this.jsonBody(data);
    return this.send("POST");
  }

  /**
   * Sends a PUT request, optionally using the provided value as a JSON body.
   *
   * @param data - Optional JSON body value.
   * @returns The upstream Fetch API response.
   */
  put(data?: unknown): Promise<Response> {
    if (data !== undefined) this.jsonBody(data);
    return this.send("PUT");
  }

  /**
   * Sends a PATCH request, optionally using the provided value as a JSON body.
   *
   * @param data - Optional JSON body value.
   * @returns The upstream Fetch API response.
   */
  patch(data?: unknown): Promise<Response> {
    if (data !== undefined) this.jsonBody(data);
    return this.send("PATCH");
  }

  /**
   * Sends a DELETE request.
   *
   * @returns The upstream Fetch API response.
   */
  delete(): Promise<Response> {
    return this.send("DELETE");
  }

  /**
   * Sends the configured upstream request with the selected method.
   *
   * @param method - HTTP method to use. Defaults to GET.
   * @returns The upstream Fetch API response.
   */
  send(method: HttpMethod = "GET"): Promise<Response> {
    const url = new URL(this.pathValue, this.baseUrl);
    for (const [name, value] of this.query) {
      url.searchParams.append(name, value);
    }

    return fetch(url, {
      method,
      headers: this.headers,
      body: method === "GET" || method === "HEAD" ? undefined : this.bodyValue,
      signal: this.timeoutMs ? AbortSignal.timeout(this.timeoutMs) : undefined,
    });
  }
}

/**
 * Fluent builder for forwarding the current request to another HTTP service.
 */
export class HttpProxyBuilder {
  private targetBaseUrl: string | URL | undefined;
  private prefixToStrip = "";
  private shouldForwardHeaders = false;
  private readonly requestHeaders = new Headers();
  private readonly removedRequestHeaders = new Set<string>();
  private readonly removedResponseHeaders = new Set<string>();
  private timeoutMs: number | undefined;

  /**
   * Creates a proxy builder bound to an HTTP request context.
   *
   * @param ctx - Current HTTP request context.
   */
  constructor(private readonly ctx: HttpContext) {}

  /**
   * Sets the target base URL for the proxied request.
   *
   * @param baseUrl - Target service base URL.
   * @returns This builder for chaining.
   */
  to(baseUrl: string | URL): this {
    this.targetBaseUrl = baseUrl;
    return this;
  }

  /**
   * Removes a path prefix from the incoming request path before forwarding.
   *
   * @param prefix - Prefix to strip when it matches the request path.
   * @returns This builder for chaining.
   */
  stripPrefix(prefix: string): this {
    this.prefixToStrip = prefix;
    return this;
  }

  /**
   * Forwards incoming request headers to the target service.
   *
   * Hop-by-hop headers are removed before the proxied request is sent.
   *
   * @returns This builder for chaining.
   */
  forwardHeaders(): this {
    this.shouldForwardHeaders = true;
    return this;
  }

  /**
   * Sets or overrides one proxied request header.
   *
   * @param name - Header name.
   * @param value - Header value.
   * @returns This builder for chaining.
   */
  header(name: string, value: string): this {
    this.requestHeaders.set(name, value);
    return this;
  }

  /**
   * Sets a bearer authorization header when a token is provided.
   *
   * @param token - Bearer token. Undefined values are ignored.
   * @returns This builder for chaining.
   */
  bearer(token: string | undefined): this {
    if (token) this.header("authorization", `Bearer ${token}`);
    return this;
  }

  /**
   * Removes one header from the proxied request.
   *
   * @param name - Header name to remove.
   * @returns This builder for chaining.
   */
  removeRequestHeader(name: string): this {
    this.removedRequestHeaders.add(name.toLowerCase());
    return this;
  }

  /**
   * Removes one header from the proxied response.
   *
   * @param name - Header name to remove.
   * @returns This builder for chaining.
   */
  removeResponseHeader(name: string): this {
    this.removedResponseHeaders.add(name.toLowerCase());
    return this;
  }

  /**
   * Sets a proxy request timeout.
   *
   * @param ms - Timeout in milliseconds.
   * @returns This builder for chaining.
   */
  timeout(ms: number): this {
    this.timeoutMs = ms;
    return this;
  }

  /**
   * Sends the proxied request and streams the target response back to the
   * caller.
   *
   * @returns The proxied Fetch API response.
   * @throws {@link RuntimeError} when no target URL has been configured.
   */
  async send(): Promise<Response> {
    if (!this.targetBaseUrl) {
      throw new RuntimeError(
        "MISSING_TARGET",
        "HTTP proxy target is not configured",
      );
    }

    const headers = this.shouldForwardHeaders
      ? new Headers(this.ctx.req.headers)
      : new Headers();
    headers.delete("host");
    headers.delete("connection");
    headers.delete("keep-alive");
    headers.delete("transfer-encoding");
    for (const name of this.removedRequestHeaders) headers.delete(name);
    this.requestHeaders.forEach((value, name) => headers.set(name, value));

    let path = this.ctx.req.path;
    if (this.prefixToStrip && path.startsWith(this.prefixToStrip)) {
      path = path.slice(this.prefixToStrip.length) || "/";
    }

    const targetUrl = new URL(path + this.ctx.req.search, this.targetBaseUrl);
    const response = await fetch(targetUrl, {
      method: this.ctx.req.method,
      headers,
      body:
        this.ctx.req.method === "GET" || this.ctx.req.method === "HEAD"
          ? undefined
          : await this.ctx.req.body.text(),
      signal: this.timeoutMs ? AbortSignal.timeout(this.timeoutMs) : undefined,
    });

    const responseHeaders = new Headers(response.headers);
    for (const name of this.removedResponseHeaders) {
      responseHeaders.delete(name);
    }
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  }
}

/**
 * Creates an upstream request builder outside of a handler context.
 *
 * @param baseUrl - Base URL for the upstream service.
 * @returns A fluent upstream request builder.
 */
export function upstream(baseUrl: string | URL): HttpUpstreamBuilder {
  return new HttpUpstreamBuilder(baseUrl);
}

/**
 * Creates a proxy builder for the current HTTP context.
 *
 * @param ctx - Current HTTP request context.
 * @returns A fluent proxy builder.
 */
export function proxy(ctx: HttpContext): HttpProxyBuilder {
  return new HttpProxyBuilder(ctx);
}

/**
 * Starts a response builder with a custom status code.
 *
 * @param statusCode - HTTP status code for the response.
 * @returns A response builder.
 */
export function status(statusCode: number): HttpResponseBuilder {
  return new HttpResponseFactory().status(statusCode);
}

/**
 * Creates a JSON response.
 *
 * @param data - Value serialized with `JSON.stringify`.
 * @param init - Optional status and headers.
 * @returns A response with `application/json; charset=utf-8` unless another
 * content type is provided.
 */
export function json<T>(data: T, init?: ResponseInit): Response {
  return new HttpResponseFactory().json(data, init);
}

/**
 * Creates a plain-text response.
 *
 * @param data - Text body to send.
 * @param init - Optional status and headers.
 * @returns A response with `text/plain; charset=utf-8` unless another content
 * type is provided.
 */
export function text(data: string, init?: ResponseInit): Response {
  return new HttpResponseFactory().text(data, init);
}

/**
 * Creates an HTML response.
 *
 * @param data - HTML body to send.
 * @param init - Optional status and headers.
 * @returns A response with `text/html; charset=utf-8` unless another content
 * type is provided.
 */
export function html(data: string, init?: ResponseInit): Response {
  return new HttpResponseFactory().html(data, init);
}

/**
 * Creates a `204 No Content` response.
 *
 * @returns A response without a body.
 */
export function noContent(): Response {
  return new HttpResponseFactory().noContent();
}

/**
 * Creates a redirect response.
 *
 * @param url - Redirect target URL.
 * @param status - Redirect status code. Defaults to 307.
 * @returns A response with a `location` header and no body.
 */
export function redirect(
  url: string | URL,
  status: RedirectStatus = 307,
): Response {
  return new HttpResponseFactory().redirect(url, status);
}

/**
 * Creates a JSON error response using Edge Connector error envelope.
 *
 * @param statusCode - HTTP status code for the error response.
 * @param message - Human-readable error message.
 * @param code - Machine-readable error code. Defaults to the status code.
 * @returns A JSON response shaped as `{ error: { code, message } }`.
 */
export function error(
  statusCode: number,
  message: string,
  code?: string,
): Response {
  return new HttpResponseFactory().error(statusCode, message, code);
}

/**
 * Creates a `400 Bad Request` error response.
 *
 * @param message - Human-readable error message.
 * @returns A JSON error response with code `BAD_REQUEST`.
 */
export function badRequest(message: string): Response {
  return new HttpResponseFactory().badRequest(message);
}

/**
 * Creates a `401 Unauthorized` error response.
 *
 * @param message - Human-readable error message.
 * @returns A JSON error response with code `UNAUTHORIZED`.
 */
export function unauthorized(message?: string): Response {
  return new HttpResponseFactory().unauthorized(message);
}

/**
 * Creates a `403 Forbidden` error response.
 *
 * @param message - Human-readable error message.
 * @returns A JSON error response with code `FORBIDDEN`.
 */
export function forbidden(message?: string): Response {
  return new HttpResponseFactory().forbidden(message);
}

/**
 * Creates a `404 Not Found` error response.
 *
 * @param message - Human-readable error message.
 * @returns A JSON error response with code `NOT_FOUND`.
 */
export function notFound(message?: string): Response {
  return new HttpResponseFactory().notFound(message);
}

/**
 * Creates a `409 Conflict` error response.
 *
 * @param message - Human-readable error message.
 * @returns A JSON error response with code `CONFLICT`.
 */
export function conflict(message?: string): Response {
  return new HttpResponseFactory().conflict(message);
}

/**
 * Creates a `422 Unprocessable Entity` error response.
 *
 * @param message - Human-readable error message.
 * @returns A JSON error response with code `UNPROCESSABLE_ENTITY`.
 */
export function unprocessableEntity(message: string): Response {
  return new HttpResponseFactory().unprocessableEntity(message);
}

/**
 * Creates a `500 Internal Server Error` error response.
 *
 * @param message - Human-readable error message.
 * @returns A JSON error response with code `INTERNAL_SERVER_ERROR`.
 */
export function internalServerError(message?: string): Response {
  return new HttpResponseFactory().internalServerError(message);
}

function parseCookieHeader(header: string | null): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) continue;
    cookies[rawName] = decodeURIComponent(rawValue.join("="));
  }
  return cookies;
}

function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions,
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join("; ");
}

function interpolatePath(
  template: string,
  params: Record<string, string | number>,
): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new RuntimeError(
        "MISSING_PARAMETER",
        `Missing path parameter "${name}"`,
      );
    }
    return encodeURIComponent(String(value));
  });
}

function isRedirectStatus(statusCode: number): statusCode is RedirectStatus {
  return (
    statusCode === 301 ||
    statusCode === 302 ||
    statusCode === 303 ||
    statusCode === 307 ||
    statusCode === 308
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
