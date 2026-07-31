/**
 * AD Single User Endpoint
 *
 * GET /ad/users/:id - Get a single user from Active Directory
 *
 * The :id parameter is the sAMAccountName (login name).
 *
 * Example:
 *   GET /ad/users/mmueller
 */

import { defineHttp } from "@flamox/edge-connector-sdk";

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
  memberOf: string[];
  // Sensitive fields (removed from responses).
  objectGUID?: string;
  objectSid?: string;
}

/**
 * Normalized detailed user type.
 */
interface DetailedUser {
  id: string;
  displayName: string;
  email: string;
  department: string;
  jobTitle: string;
  phone: string;
  managerId: string | null;
  groups: string[];
}

/**
 * Extracts the CN from a distinguished name.
 */
function extractCn(dn: string): string {
  const match = dn.match(/^CN=([^,]+)/i);
  return match ? match[1] : dn;
}

/**
 * Normalizes user data with groups.
 */
function normalizeUser(user: AdUser): DetailedUser {
  return {
    id: user.sAMAccountName,
    displayName: user.displayName || "",
    email: user.mail || "",
    department: user.department || "",
    jobTitle: user.title || "",
    phone: user.telephoneNumber || "",
    managerId: user.manager ? extractCn(user.manager) : null,
    groups: (user.memberOf || []).map(extractCn),
  };
}

export default defineHttp({
  get: async (ctx) => {
    const id = ctx.req.params.require("id");
    const bridgeUrl = ctx.env.AD_BRIDGE_URL || "http://localhost:5000";
    const apiToken = ctx.env.AD_BRIDGE_TOKEN;

    // Send request to the bridge.
    const url = `${bridgeUrl}/api/v1/users/${encodeURIComponent(id)}`;

    const headers: HeadersInit = {
      "Accept": "application/json",
      "X-Request-Id": ctx.requestId,
    };

    if (apiToken) {
      headers["Authorization"] = `Bearer ${apiToken}`;
    }

    try {
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10000),
      });

      if (response.status === 404) {
        return ctx.res.notFound(`User '${id}' not found`);
      }

      if (!response.ok) {
        const errorText = await response.text();
        return ctx.res.error(response.status, `Bridge error: ${errorText}`);
      }

      const data = await response.json() as { user: AdUser };

      // Normalize user.
      const user = normalizeUser(data.user);

      return ctx.res.ok().json(user);
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return ctx.res.error(504, "Bridge-Timeout");
      }
      return ctx.res.error(502, `Bridge is unreachable: ${error}`);
    }
  },
});
