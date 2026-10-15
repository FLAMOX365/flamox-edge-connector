/**
 * ERP Customers Endpoint
 *
 * GET /erp/customers - List all customers
 * POST /erp/customers - Create a new customer
 *
 * Maps to: /sap/opu/odata/sap/CUSTOMERS_SRV/CustomerSet
 */

import { defineHttp } from "@edge-connector/sdk";
import {
  cleanResponseHeaders,
  createSapHeaders,
  extractODataResults,
  normalizeSapError,
} from "../../_shared/sap.ts";

const SAP_ENDPOINT = "/sap/opu/odata/sap/CUSTOMERS_SRV/CustomerSet";

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
      const customers = extractODataResults(data);

      return new Response(JSON.stringify(customers), {
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

  post: async (ctx) => {
    const sapUrl = ctx.env.ERP_URL;
    if (!sapUrl) {
      return ctx.res.internalServerError("ERP_URL is not configured");
    }

    const url = new URL(SAP_ENDPOINT, sapUrl);
    const headers = createSapHeaders(ctx.requestId, ctx.env, true);

    try {
      const body = await ctx.req.body.text();

      const response = await fetch(url.href, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const errorData = await response.json();
        const error = normalizeSapError(errorData);
        return ctx.res.error(response.status, error.message, error.code);
      }

      const data = await response.json();
      const customer = extractODataResults(data);

      return new Response(JSON.stringify(customer), {
        status: 201,
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
