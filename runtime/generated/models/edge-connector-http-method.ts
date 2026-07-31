export type EdgeConnectorHttpMethod =
  | ("GET")
  | ("POST")
  | ("PUT")
  | ("PATCH")
  | ("DELETE")
  | ("HEAD")
  | ("OPTIONS");

/**
 * All possible values of the enum `EdgeConnectorHttpMethod`.
 */
export const EDGE_CONNECTOR_HTTP_METHOD_VALUES = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;
