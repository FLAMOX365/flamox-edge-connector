// Generated from OpenAPI schemas. Do not edit manually.

import type { EdgeConnectorHttpMethod } from "./edge-connector-http-method.ts";

export type EdgeConnectorHttpRequest = {
  method: EdgeConnectorHttpMethod;
  url: string;
  headers?: {
    [key: string]: Array<string>;
  };
  body?: (string) | null;
  timeoutSeconds?: number;
};
