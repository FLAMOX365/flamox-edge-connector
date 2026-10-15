/**
 * AD Group Members Endpoint
 *
 * GET /ad/groups/:id/members - List members of an AD group
 */

import { defineHttp } from "@edge-connector/sdk";

interface AdMember {
  sAMAccountName: string;
  displayName: string;
  mail: string;
  objectClass: string[];
}

interface NormalizedMember {
  id: string;
  displayName: string;
  email: string;
  type: "user" | "group" | "computer" | "unknown";
}

function detectType(objectClass: string[]): NormalizedMember["type"] {
  if (objectClass.includes("user")) return "user";
  if (objectClass.includes("group")) return "group";
  if (objectClass.includes("computer")) return "computer";
  return "unknown";
}

function normalizeMember(member: AdMember): NormalizedMember {
  return {
    id: member.sAMAccountName,
    displayName: member.displayName || member.sAMAccountName,
    email: member.mail || "",
    type: detectType(member.objectClass || []),
  };
}

export default defineHttp({
  get: async (ctx) => {
    const id = ctx.req.params.require("id");
    const bridgeUrl = ctx.env.AD_BRIDGE_URL || "http://localhost:5000";
    const apiToken = ctx.env.AD_BRIDGE_TOKEN;

    const url = `${bridgeUrl}/api/v1/groups/${encodeURIComponent(id)}/members`;

    const headers: HeadersInit = {
      Accept: "application/json",
      "X-Request-Id": ctx.requestId,
    };

    if (apiToken) {
      headers["Authorization"] = `Bearer ${apiToken}`;
    }

    try {
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(30000),
      });

      if (response.status === 404) {
        return ctx.res.notFound(`Group '${id}' not found`);
      }

      if (!response.ok) {
        const errorText = await response.text();
        return ctx.res.error(response.status, `Bridge error: ${errorText}`);
      }

      const data = (await response.json()) as { members: AdMember[] };
      const members = data.members.map(normalizeMember);

      return ctx.res.ok().json({
        groupId: id,
        members,
        count: members.length,
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
