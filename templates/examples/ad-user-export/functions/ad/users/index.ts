/**
 * AD Users Endpoint
 *
 * GET /ad/users - List users from Active Directory
 *
 * Query parameters:
 * - department: Filter by department (for example "IT", "HR")
 * - limit: Maximum number of results (default: 100)
 *
 * Example:
 *   GET /ad/users?department=IT&limit=50
 */

import { defineHttp } from "@edge-connector/sdk";

/**
 * User type returned by the AD bridge.
 */
interface AdUser {
  sAMAccountName: string;
  displayName: string;
  mail: string;
  department: string;
  title: string;
  telephoneNumber: string;
  manager: string;
  // Sensitive fields (removed from responses).
  objectGUID?: string;
  objectSid?: string;
  userAccountControl?: number;
  whenCreated?: string;
  whenChanged?: string;
}

/**
 * Normalized user type for the cloud.
 */
interface NormalizedUser {
  id: string;
  displayName: string;
  email: string;
  department: string;
  jobTitle: string;
  phone: string;
  managerId: string | null;
}

/**
 * Removes sensitive fields and normalizes user data.
 */
function normalizeUser(user: AdUser): NormalizedUser {
  return {
    id: user.sAMAccountName,
    displayName: user.displayName || "",
    email: user.mail || "",
    department: user.department || "",
    jobTitle: user.title || "",
    phone: user.telephoneNumber || "",
    managerId: user.manager ? extractCn(user.manager) : null,
  };
}

/**
 * Extracts the CN from a distinguished name.
 *
 * Example: "CN=Max Mueller,OU=IT,DC=example,DC=com" -> "Max Mueller"
 */
function extractCn(dn: string): string {
  const match = dn.match(/^CN=([^,]+)/i);
  return match ? match[1] : dn;
}

export default defineHttp({
  get: async (ctx) => {
    const bridgeUrl = ctx.env.AD_BRIDGE_URL || "http://localhost:5000";
    const apiToken = ctx.env.AD_BRIDGE_TOKEN;

    // Build bridge API URL.
    const url = new URL("/api/v1/users", bridgeUrl);

    // Transform query parameters.
    const department = ctx.req.query.get("department");
    if (department) {
      url.searchParams.set("filter", `(department=${department})`);
    }

    const limit = ctx.req.query.get("limit") || "100";
    url.searchParams.set("limit", limit);

    // Send request to the bridge.
    const headers: HeadersInit = {
      Accept: "application/json",
      "X-Request-Id": ctx.requestId,
    };

    if (apiToken) {
      headers["Authorization"] = `Bearer ${apiToken}`;
    }

    try {
      const response = await fetch(url.href, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return ctx.res.error(response.status, `Bridge error: ${errorText}`);
      }

      const data = (await response.json()) as { users: AdUser[] };

      // Normalize users and remove sensitive fields.
      const users = data.users.map(normalizeUser);

      return ctx.res.ok().json({
        users,
        count: users.length,
        timestamp: ctx.startedAt,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return ctx.res.error(504, "Bridge timeout: request took too long");
      }
      return ctx.res.error(502, `Bridge is unreachable: ${error}`);
    }
  },
});
