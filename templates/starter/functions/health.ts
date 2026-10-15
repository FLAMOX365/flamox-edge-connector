/**
 * Health Endpoint
 *
 * GET /health - Returns connector status.
 */

import { http } from "@edge-connector/sdk";

export default http().get((ctx) => {
  return ctx.res.ok().json({
    status: "ok",
    timestamp: ctx.startedAt,
  });
});
