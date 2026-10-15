/**
 * SAP OData Utilities
 *
 * Shared functions for the ERP integration.
 */

/**
 * Creates SAP-specific request headers.
 */
export function createSapHeaders(
  requestId: string,
  env: Record<string, string>,
  includeToken = false,
): Headers {
  const headers = new Headers();

  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");
  headers.set("sap-client", "100");
  headers.set("sap-system", env.ERP_SYSTEM || "PRD");
  headers.set("x-request-id", requestId);

  // Basic Auth
  const user = env.ERP_USER;
  const password = env.ERP_PASSWORD;
  if (user && password) {
    const credentials = btoa(`${user}:${password}`);
    headers.set("Authorization", `Basic ${credentials}`);
  }

  // CSRF token for write operations.
  if (includeToken) {
    headers.set("x-csrf-token", "Fetch");
  }

  return headers;
}

/**
 * Extracts data from SAP OData responses.
 *
 * Supports OData v2 and v4 formats.
 */
export function extractODataResults<T>(data: unknown): T[] | T | null {
  const body = data as Record<string, unknown>;

  // OData v2: { d: { results: [...] } }
  if (body?.d) {
    const d = body.d as Record<string, unknown>;
    if (d.results && Array.isArray(d.results)) {
      return d.results as T[];
    }
    // OData v2 single object: { d: { ... } }
    return d as T;
  }

  // OData v4: { value: [...] }
  if (body?.value && Array.isArray(body.value)) {
    return body.value as T[];
  }

  return null;
}

/**
 * Normalizes SAP error messages.
 */
export function normalizeSapError(data: unknown): {
  code: string;
  message: string;
} {
  const body = data as Record<string, unknown>;

  // SAP error format: { error: { message: { value: "..." }, code: "..." } }
  if (body?.error) {
    const error = body.error as Record<string, unknown>;
    const message = error.message as Record<string, string>;

    return {
      code: String(error.code || "SAP_ERROR"),
      message: message?.value || String(error.message) || "Unknown SAP error",
    };
  }

  return {
    code: "UNKNOWN_ERROR",
    message: "Unknown error from SAP",
  };
}

/**
 * Headers that should be removed from SAP responses.
 */
export const SAP_INTERNAL_HEADERS = [
  "sap-system",
  "sap-client",
  "sap-statistics",
  "sap-processing-info",
  "x-csrf-token",
];

/**
 * Creates sanitized response headers.
 */
export function cleanResponseHeaders(
  original: Headers,
  requestId: string,
): Headers {
  const headers = new Headers();

  original.forEach((value, key) => {
    if (!SAP_INTERNAL_HEADERS.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  });

  headers.set("x-request-id", requestId);
  return headers;
}
