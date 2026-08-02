// Generated from OpenAPI schemas. Do not edit manually.

import type { EdgeConnectorError } from "./edge-connector-error.ts";
import type { _EdgeConnectorFrameBase } from "./edge-connector-frame.ts";
import type { EdgeConnectorHttpResponse } from "./edge-connector-http-response.ts";
import type { EdgeConnectorResponseFrameType } from "./edge-connector-response-frame-type.ts";

export type EdgeConnectorResponseFrame = _EdgeConnectorFrameBase & {
  type: EdgeConnectorResponseFrameType;
  requestId: string;
  response?: EdgeConnectorHttpResponse;
  error?: EdgeConnectorError;
};
