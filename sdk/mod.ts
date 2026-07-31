/**
 * @flamox/edge-connector-sdk
 *
 * Public authoring contract for legacy HTTP/YAML-compatible functions and
 * managed Edge Connector extensions.
 *
 * @module
 */

// Legacy HTTP function API. This remains source-compatible with the original
// connector so existing customer functions continue to run unchanged after
// switching their import to the rebranded package.
export {
  badRequest,
  conflict,
  createHttpContext,
  defineHttp,
  error,
  forbidden,
  html,
  http,
  HTTP_METHODS,
  HttpResponseFactory,
  internalServerError,
  isHttpRouteDefinition,
  json,
  noContent,
  notFound,
  proxy,
  redirect,
  status,
  text,
  unauthorized,
  unprocessableEntity,
  upstream,
} from "./http.ts";
export type {
  CreateHttpContextOptions,
  DefineHttpConfig,
  HttpContext,
  HttpErrorHandler,
  HttpHandler,
  HttpMiddleware,
  HttpRouteDefinition,
} from "./http.ts";
export type { HttpMethod } from "./types.ts";
export { ErrorCodes, RuntimeError } from "./errors.ts";

// Managed extension API.
export { defineExtension, isExtensionDefinition } from "./extension.ts";
export type {
  ExtensionActionContext,
  ExtensionActionHandler,
  ExtensionDefinition,
  JsonValue,
} from "./extension.ts";
export {
  defineTelephonyProvider,
  TELEPHONY_AREA,
  TELEPHONY_PROVIDER_CONTRACT,
  TELEPHONY_PROVIDER_CONTRACT_VERSION,
} from "./areas/telephony.ts";
export { TELEPHONY_PROVIDER_OPERATION_SCHEMAS } from "./areas/telephony-schemas.ts";
export type { TelephonyProviderOperation } from "./areas/telephony-schemas.ts";
export type {
  TelephonyCallRecord,
  TelephonyEndCallRequest,
  TelephonyEndCallResult,
  TelephonyHealthRequest,
  TelephonyHealthResult,
  TelephonyProviderDefinition,
  TelephonyStartCallRequest,
  TelephonyStartCallResult,
  TelephonySynchronizeCallsRequest,
  TelephonySynchronizeCallsResult,
} from "./areas/telephony.ts";
