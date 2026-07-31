/**
 * Proxy Endpoint
 *
 * GET/POST/PUT/DELETE /proxy/* - Forwards requests to an internal API
 *
 * This example shows how to:
 * - Use Edge Connector as a proxy
 * - Add authentication from environment variables
 * - Transform headers
 *
 * Note: In a real application, you would read the internal URL from an
 * environment variable.
 */

import { defineHttp, type HttpContext } from "@flamox/edge-connector-sdk";

// Internal API URL from the environment.
const getInternalUrl = (env: Record<string, string>) =>
  env.INTERNAL_API_URL || "http://localhost:3000";

export default defineHttp({
  get: proxyRequest,
  post: proxyRequest,
  put: proxyRequest,
  delete: proxyRequest,
});

/**
 * Forwards the request to the internal API.
 */
async function proxyRequest(ctx: HttpContext): Promise<Response> {
  const internalUrl = getInternalUrl(ctx.env);
  return ctx.proxy
    .to(internalUrl)
    .stripPrefix("/proxy")
    .forwardHeaders()
    .bearer(ctx.env.INTERNAL_API_TOKEN)
    .header("x-request-id", ctx.requestId)
    .removeResponseHeader("x-internal-debug")
    .removeResponseHeader("server")
    .send();
}
