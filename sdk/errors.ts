/**
 * @flamox/edge-connector-sdk
 *
 * Error types for Edge Connector functions.
 *
 * @module
 */

/**
 * An error that rejects a request with a specific code and message.
 *
 * Throw this from a function handler to reject the request. The error will be
 * returned to the FLAMOX365 Cloud as an error response.
 *
 * @example
 * ```ts
 * import { RuntimeError } from "@flamox/edge-connector-sdk";
 *
 * if (ctx.req.path.startsWith("/admin")) {
 *   throw new RuntimeError("FORBIDDEN", "Admin access not allowed");
 * }
 * ```
 */
export class RuntimeError extends Error {
  /**
   * Creates a new RuntimeError.
   *
   * @param code - Error code (e.g., "FORBIDDEN", "VALIDATION_ERROR")
   * @param message - Human-readable error message
   * @param options - Standard Error options (cause, etc.)
   */
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeError";
  }
}

/**
 * Common error codes for use with RuntimeError.
 */
export const ErrorCodes = {
  /** Request is forbidden (403) */
  FORBIDDEN: "FORBIDDEN",
  /** Resource not found (404) */
  NOT_FOUND: "NOT_FOUND",
  /** Method not allowed (405) */
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  /** Validation failed (400) */
  VALIDATION_ERROR: "VALIDATION_ERROR",
  /** Rate limit exceeded (429) */
  RATE_LIMITED: "RATE_LIMITED",
  /** Service unavailable (503) */
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  /** Request rejected by policy */
  REQUEST_REJECTED: "REQUEST_REJECTED",
  /** Configuration error */
  CONFIGURATION_ERROR: "CONFIGURATION_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
