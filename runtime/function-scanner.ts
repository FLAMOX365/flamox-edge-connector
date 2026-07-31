/**
 * HTTP Function Scanner
 *
 * Scans a directory for HTTP function files and builds a route registry.
 * Similar to Next.js App Router's file-based routing.
 *
 * Supports:
 * - TypeScript functions (.ts, .js, .mts, .mjs)
 * - YAML declarative functions (.yml, .yaml)
 *
 * @module
 */

import { extname, join, relative, resolve, toFileUrl } from "@std/path";
import type { HttpContext, HttpHandler } from "../sdk/http.ts";
import { HTTP_METHODS, isHttpRouteDefinition } from "../sdk/http.ts";
import type { HttpMethod } from "../sdk/types.ts";
import type { RuntimeLogger } from "./logger.ts";
import { createLogger } from "./logger.ts";
import {
  createYamlFunctionHandler,
  parseYamlFunctionConfig,
  type YamlFunctionContext,
} from "./yaml-functions.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * A registered route with its handlers.
 */
export interface RegisteredHttpRoute {
  /** URL pattern for matching */
  pattern: URLPattern;
  /** Route path (for logging) */
  path: string;
  /** Map of HTTP method to handler function */
  handlers: Map<HttpMethod, HttpHandler>;
  /** Original file path */
  filePath: string;
  /** True for functions/index.* acting as the root catch-all handler. */
  isRootHandler: boolean;
}

/**
 * Result of matching a request to a route.
 */
export interface RouteMatch {
  /** The handler function to execute */
  handler: HttpHandler;
  /** URL path parameters */
  params: Record<string, string>;
  /** The matched route */
  route: RegisteredHttpRoute;
}

// ============================================================================
// Function Scanner
// ============================================================================

/**
 * Scans a directory for function files and registers routes.
 *
 * File structure:
 * ```
 * functions/
 * ├── health.ts                    → /health
 * ├── health.yml                   → /health (YAML declarative)
 * ├── users/
 * │   ├── index.ts                 → /users
 * │   └── [id].ts                  → /users/:id
 * ├── tickets/
 * │   └── index.yml                → /tickets (YAML declarative)
 * └── ad/
 *     └── groups/
 *         └── [name]/
 *             └── members.ts       → /ad/groups/:name/members
 * ```
 */
export class HttpFunctionScanner {
  private routes: RegisteredHttpRoute[] = [];
  private logger: RuntimeLogger;
  private env: Record<string, string>;

  constructor(options?: {
    logger?: RuntimeLogger;
    env?: Record<string, string>;
  }) {
    this.logger = options?.logger ?? createLogger();
    this.env = options?.env ?? Deno.env.toObject();
  }

  /**
   * Scan a directory for function files.
   *
   * @param functionsDir - Path to the functions directory
   */
  async scan(functionsDir: string): Promise<void> {
    const absoluteDir = resolve(functionsDir);

    this.logger.info(`Scanning functions in ${absoluteDir}`);

    const routes: RegisteredHttpRoute[] = [];
    for await (const entry of this.walkDirectory(absoluteDir)) {
      if (!this.isHandlerFile(entry.path)) continue;

      const route = this.filePathToRoute(absoluteDir, entry.path);
      const ext = extname(entry.path).toLowerCase();
      const isYaml = ext === ".yml" || ext === ".yaml";
      const isRootHandler = this.isRootIndexFile(absoluteDir, entry.path);

      const handlers = isYaml
        ? await this.loadYamlHandlers(entry.path)
        : await this.loadHandlers(entry.path);

      if (handlers.size === 0) {
        this.logger.warn(`  ${route} - No HTTP method exports found, skipping`);
        continue;
      }

      const pattern = new URLPattern({
        pathname: isRootHandler ? "/*" : route,
      });

      routes.push({
        pattern,
        path: route,
        handlers,
        filePath: entry.path,
        isRootHandler,
      });
    }

    this.routes = routes.sort(compareRoutes);
    this.logRoutes(absoluteDir);
  }

  /**
   * Get the number of registered routes.
   */
  get routeCount(): number {
    return this.routes.length;
  }

  /**
   * Get all registered routes.
   */
  getRoutes(): readonly RegisteredHttpRoute[] {
    return this.routes;
  }

  /**
   * Match a request to a route.
   *
   * @param request - The incoming request
   * @returns RouteMatch if found, null otherwise
   */
  match(request: Request): RouteMatch | null {
    const url = new URL(request.url);
    const method = request.method as HttpMethod;

    for (const route of this.routes) {
      const match = route.pattern.exec(url);
      if (match) {
        const handler = route.handlers.get(method);
        if (handler) {
          return {
            handler,
            params: (match.pathname.groups as Record<string, string>) ?? {},
            route,
          };
        }
        // Route matched but method not allowed - continue to check other routes
        // (in case of overlapping patterns)
      }
    }

    return null;
  }

  /**
   * Check if a route exists for the given pathname (regardless of method).
   */
  hasRoute(pathname: string): boolean {
    const url = new URL(pathname, "http://localhost");
    return this.routes.some((r) => r.pattern.test(url));
  }

  /**
   * Get allowed methods for a pathname.
   */
  getAllowedMethods(pathname: string): HttpMethod[] {
    const url = new URL(pathname, "http://localhost");
    for (const route of this.routes) {
      if (route.pattern.test(url)) {
        return [...route.handlers.keys()];
      }
    }
    return [];
  }

  // ========================================================================
  // Private Methods
  // ========================================================================

  /**
   * Convert a file path to a URL route.
   *
   * @example
   * functions/users/index.ts → /users
   * functions/users/[id].ts → /users/:id
   * functions/tickets/index.yml → /tickets
   * functions/ad/groups/[name]/members.ts → /ad/groups/:name/members
   */
  private filePathToRoute(baseDir: string, filePath: string): string {
    let route = filePath
      .replace(baseDir, "")
      .replace(/\\/g, "/") // Windows paths
      .replace(/\.(ts|js|mts|mjs|yml|yaml)$/, "") // Remove extension (TS, JS, YAML)
      .replace(/\/index$/, ""); // /index → /

    // Catch-all segments: [...path] → :path*
    route = route.replace(/\[\.\.\.([^\]]+)\]/g, ":$1*");

    // Dynamic segments: [id] → :id
    route = route.replace(/\[([^\]]+)\]/g, ":$1");

    return route || "/";
  }

  private isRootIndexFile(baseDir: string, filePath: string): boolean {
    const relativePath = relative(baseDir, filePath).replace(/\\/g, "/");
    return /^index\.(ts|js|mts|mjs|yml|yaml)$/.test(relativePath);
  }

  private logRoutes(baseDir: string): void {
    if (this.routes.length === 0) {
      this.logger.warn(`No function routes registered from ${baseDir}`);
      return;
    }

    this.logger.info(`${this.routes.length} function route(s) registered:`);
    for (const route of this.routes) {
      const methods = [...route.handlers.keys()].join(", ");
      const label = route.isRootHandler ? "/* (root index)" : route.path;
      const type = isYamlFile(route.filePath) ? " YAML" : "";
      this.logger.info(`  ${label} [${methods}]${type} -> ${route.filePath}`);
    }
  }

  /**
   * Load handlers from a module file.
   */
  private async loadHandlers(
    filePath: string,
  ): Promise<Map<HttpMethod, HttpHandler>> {
    const handlers = new Map<HttpMethod, HttpHandler>();

    try {
      // Add cache-busting query param based on file mtime
      const stat = await Deno.stat(filePath);
      const cacheKey = stat.mtime?.getTime() ?? Date.now();
      const moduleUrl = `${toFileUrl(filePath).href}?mtime=${cacheKey}`;

      const module = await import(moduleUrl) as HttpFunctionModule;

      const routeDefinition = isHttpRouteDefinition(module.default)
        ? module.default
        : null;
      if (routeDefinition) {
        for (const method of HTTP_METHODS) {
          const handler = routeDefinition.handlers[method];
          if (handler) {
            handlers.set(method, handler);
          }
        }
      }

      // Named exports remain a functional, low-ceremony HTTP authoring style.
      for (const method of HTTP_METHODS) {
        const handler = module[method];
        if (typeof handler === "function" && !handlers.has(method)) {
          handlers.set(method, handler as HttpHandler);
        }
      }
    } catch (error) {
      this.logger.error(`Failed to load ${filePath}: ${error}`);
    }

    return handlers;
  }

  /**
   * Load handlers from a YAML function file.
   *
   * YAML functions are declarative target request definitions:
   * ```yaml
   * target: "{{ env.API_URL }}"
   * request:
   *   headers:
   *     set:
   *       authorization: "Bearer {{ env.API_TOKEN }}"
   * response:
   *   headers:
   *     remove:
   *       - x-internal-debug
   * ```
   */
  private async loadYamlHandlers(
    filePath: string,
  ): Promise<Map<HttpMethod, HttpHandler>> {
    const handlers = new Map<HttpMethod, HttpHandler>();

    try {
      const content = await Deno.readTextFile(filePath);
      const config = parseYamlFunctionConfig(content, filePath);

      // Validate required fields
      if (!config.target) {
        this.logger.error(
          `YAML function at ${filePath} is missing required 'target' field`,
        );
        return handlers;
      }

      // Create the YAML function handler
      const yamlHandler = createYamlFunctionHandler(config, filePath);

      const wrappedHandler: HttpHandler = async (
        ctx: HttpContext,
      ): Promise<Response> => {
        const yamlCtx: YamlFunctionContext = {
          requestId: ctx.requestId,
          startedAt: ctx.startedAt,
          env: this.env,
          method: ctx.req.method,
          url: ctx.req.url,
          headers: ctx.req.headers,
          body: ctx.req.method !== "GET" && ctx.req.method !== "HEAD"
            ? await ctx.req.body.text()
            : null,
          params: { ...ctx.req.params.all() },
        };
        return yamlHandler(yamlCtx);
      };

      // Determine which methods to register
      const methods: HttpMethod[] = config.methods
        ? config.methods.map((m) => m.toUpperCase() as HttpMethod).filter(
          (m) => HTTP_METHODS.includes(m),
        )
        : [...HTTP_METHODS]; // All methods by default

      for (const method of methods) {
        handlers.set(method, wrappedHandler);
      }
    } catch (error) {
      this.logger.error(`Failed to load YAML function ${filePath}: ${error}`);
    }

    return handlers;
  }

  /**
   * Check if a file is a handler file.
   */
  private isHandlerFile(path: string): boolean {
    const ext = extname(path).toLowerCase();
    const validExtensions = [".ts", ".js", ".mts", ".mjs", ".yml", ".yaml"];

    if (!validExtensions.includes(ext)) {
      return false;
    }

    // Skip files starting with underscore (shared/internal modules)
    const fileName = path.split("/").pop() ?? "";
    if (fileName.startsWith("_")) {
      return false;
    }

    // Skip test files
    if (
      path.includes(".test.") || path.includes(".spec.") ||
      path.includes("_test.")
    ) {
      return false;
    }

    return true;
  }

  /**
   * Recursively walk a directory.
   */
  private async *walkDirectory(
    dir: string,
  ): AsyncGenerator<{ name: string; path: string; isFile: boolean }> {
    try {
      for await (const entry of Deno.readDir(dir)) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory) {
          yield* this.walkDirectory(fullPath);
        } else if (entry.isFile) {
          yield { name: entry.name, path: fullPath, isFile: true };
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
      // Directory doesn't exist, that's okay
    }
  }
}

type HttpFunctionModule = {
  default?: unknown;
} & Partial<Record<HttpMethod, unknown>>;

function compareRoutes(
  a: RegisteredHttpRoute,
  b: RegisteredHttpRoute,
): number {
  return routePriority(b) - routePriority(a);
}

function routePriority(route: RegisteredHttpRoute): number {
  if (route.isRootHandler) {
    return -1_000;
  }

  const segments = route.path.split("/").filter(Boolean);
  const dynamicSegments = segments.filter((segment) => segment.startsWith(":"))
    .length;
  const catchAllSegments = segments.filter((segment) => segment.endsWith("*"))
    .length;

  return segments.length * 100 - dynamicSegments * 10 - catchAllSegments * 50;
}

function isYamlFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === ".yml" || ext === ".yaml";
}
