/**
 * ERP Orders Endpoint
 *
 * GET /erp/orders - List all orders
 *
 * Maps to: /sap/opu/odata/sap/ORDERS_SRV/OrderSet
 */

import { defineHttp } from "@edge-connector/sdk";
import {
  cleanResponseHeaders,
  createSapHeaders,
  extractODataResults,
  normalizeSapError,
} from "../../_shared/sap.ts";

const SAP_ENDPOINT = "/sap/opu/odata/sap/ORDERS_SRV/OrderSet";

export default defineHttp({
  get: async (ctx) => {
    const sapUrl = ctx.env.ERP_URL;
    if (!sapUrl) {
      return ctx.res.internalServerError("ERP_URL is not configured");
    }

    const url = new URL(SAP_ENDPOINT + ctx.req.search, sapUrl);
    const headers = createSapHeaders(ctx.requestId, ctx.env);

    try {
      const response = await fetch(url.href, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const errorData = await response.json();
        const error = normalizeSapError(errorData);
        return ctx.res.error(response.status, error.message, error.code);
      }

      const data = await response.json();
      const orders = extractODataResults(data);

      return new Response(JSON.stringify(orders), {
        status: 200,
        headers: cleanResponseHeaders(response.headers, ctx.requestId),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return ctx.res.error(504, "SAP timeout", "SAP_TIMEOUT");
      }
      return ctx.res.error(
        502,
        `SAP is unreachable: ${error}`,
        "SAP_UNREACHABLE",
      );
    }
  },
});
