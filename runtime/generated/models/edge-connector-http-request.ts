import type { EdgeConnectorHttpMethod } from "./edge-connector-http-method.ts";

export type EdgeConnectorHttpRequest = {
  method: EdgeConnectorHttpMethod;
  url: string;
  headers?: {
    [key: string]: (string)[];
  };
  body?: (string) | (null);
  timeoutSeconds?: number;
};
