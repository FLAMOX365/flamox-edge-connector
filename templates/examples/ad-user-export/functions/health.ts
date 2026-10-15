/**
 * Health endpoint for AD User Export.
 *
 * GET /health - Checks whether the connector and bridge are reachable.
 */

import { defineHttp } from "@edge-connector/sdk";

export default defineHttp({
  get: async (ctx) => {
    const bridgeUrl = ctx.env.AD_BRIDGE_URL || "http://localhost:5000";

    try {
      // Bridge health check.
      const response = await fetch(`${bridgeUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return ctx.res.status(503).json({
          status: "degraded",
          connector: "ok",
          bridge: "error",
          timestamp: ctx.startedAt,
        });
      }

      return ctx.res.ok().json({
        status: "ok",
        connector: "ok",
        bridge: "ok",
        timestamp: ctx.startedAt,
      });
    } catch (_error) {
      return ctx.res.status(503).json({
        status: "degraded",
        connector: "ok",
        bridge: "unreachable",
        timestamp: ctx.startedAt,
      });
    }
  },
});
