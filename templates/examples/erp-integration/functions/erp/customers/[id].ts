/**
 * ERP Single Customer Endpoint
 *
 * GET    /erp/customers/:id - Get a single customer
 * PUT    /erp/customers/:id - Update a customer
 * DELETE /erp/customers/:id - Delete a customer
 *
 * Maps to: /sap/opu/odata/sap/CUSTOMERS_SRV/CustomerSet('id')
 */

import { defineHttp } from "@edge-connector/sdk";
import {
  cleanResponseHeaders,
  createSapHeaders,
  extractODataResults,
  normalizeSapError,
} from "../../_shared/sap.ts";

function getSapEndpoint(id: string): string {
  return `/sap/opu/odata/sap/CUSTOMERS_SRV/CustomerSet('${id}')`;
}

export default defineHttp({
  get: async (ctx) => {
    const id = ctx.req.params.require("id");
    const sapUrl = ctx.env.ERP_URL;
    if (!sapUrl) {
      return ctx.res.internalServerError("ERP_URL is not configured");
    }

    const url = new URL(getSapEndpoint(id), sapUrl);
    const headers = createSapHeaders(ctx.requestId, ctx.env);

    try {
      const response = await fetch(url.href, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10000),
      });

      if (response.status === 404) {
        return ctx.res.notFound(`Customer '${id}' not found`);
      }

      if (!response.ok) {
        const errorData = await response.json();
        const error = normalizeSapError(errorData);
        return ctx.res.error(response.status, error.message, error.code);
      }

      const data = await response.json();
      const customer = extractODataResults(data);

      return new Response(JSON.stringify(customer), {
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

  put: async (ctx) => {
    const id = ctx.req.params.require("id");
    const sapUrl = ctx.env.ERP_URL;
    if (!sapUrl) {
      return ctx.res.internalServerError("ERP_URL is not configured");
    }

    const url = new URL(getSapEndpoint(id), sapUrl);
    const headers = createSapHeaders(ctx.requestId, ctx.env, true);
    headers.set("If-Match", "*"); // Optimistic locking

    try {
      const body = await ctx.req.body.text();

      const response = await fetch(url.href, {
        method: "PUT",
        headers,
        body,
        signal: AbortSignal.timeout(30000),
      });

      if (response.status === 404) {
        return ctx.res.notFound(`Customer '${id}' not found`);
      }

      if (!response.ok) {
        const errorData = await response.json();
        const error = normalizeSapError(errorData);
        return ctx.res.error(response.status, error.message, error.code);
      }

      const data = await response.json();
      const customer = extractODataResults(data);

      return new Response(JSON.stringify(customer), {
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

  delete: async (ctx) => {
    const id = ctx.req.params.require("id");
    const sapUrl = ctx.env.ERP_URL;
    if (!sapUrl) {
      return ctx.res.internalServerError("ERP_URL is not configured");
    }

    const url = new URL(getSapEndpoint(id), sapUrl);
    const headers = createSapHeaders(ctx.requestId, ctx.env, true);
    headers.set("If-Match", "*");

    try {
      const response = await fetch(url.href, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(30000),
      });

      if (response.status === 404) {
        return ctx.res.notFound(`Customer '${id}' not found`);
      }

      if (!response.ok) {
        const errorData = await response.json();
        const error = normalizeSapError(errorData);
        return ctx.res.error(response.status, error.message, error.code);
      }

      return ctx.res.noContent();
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
