/**
 * AD Groups Endpoint
 *
 * GET /ad/groups - List groups from Active Directory
 *
 * Query parameters:
 * - prefix: Filter by group-name prefix (for example "APP-", "SEC-")
 * - limit: Maximum number of results (default: 100)
 */

import { defineHttp } from "@edge-connector/sdk";

interface AdGroup {
  sAMAccountName: string;
  description: string;
  member: string[];
  // Sensitive fields.
  objectGUID?: string;
  objectSid?: string;
}

interface NormalizedGroup {
  id: string;
  name: string;
  description: string;
  memberCount: number;
}

function normalizeGroup(group: AdGroup): NormalizedGroup {
  return {
    id: group.sAMAccountName,
    name: group.sAMAccountName,
    description: group.description || "",
    memberCount: group.member?.length || 0,
  };
}

export default defineHttp({
  get: async (ctx) => {
    const bridgeUrl = ctx.env.AD_BRIDGE_URL || "http://localhost:5000";
    const apiToken = ctx.env.AD_BRIDGE_TOKEN;

    const url = new URL("/api/v1/groups", bridgeUrl);

    // Transform query parameters.
    const prefix = ctx.req.query.get("prefix");
    if (prefix) {
      url.searchParams.set("filter", `(name=${prefix}*)`);
    }

    const limit = ctx.req.query.get("limit") || "100";
    url.searchParams.set("limit", limit);

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

      const data = (await response.json()) as { groups: AdGroup[] };
      const groups = data.groups.map(normalizeGroup);

      return ctx.res.ok().json({
        groups,
        count: groups.length,
        timestamp: ctx.startedAt,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return ctx.res.error(504, "Bridge-Timeout");
      }
      return ctx.res.error(502, `Bridge is unreachable: ${error}`);
    }
  },
});
