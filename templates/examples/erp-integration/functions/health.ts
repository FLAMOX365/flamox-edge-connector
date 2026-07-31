/**
 * Health endpoint for the ERP integration.
 */

import { defineHttp } from "@flamox/edge-connector-sdk";

export default defineHttp({
  get: (ctx) => {
    return ctx.res.ok().json({
      status: "ok",
      timestamp: ctx.startedAt,
    });
  },
});
