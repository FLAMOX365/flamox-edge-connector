import type { EdgeConnectorError } from "./edge-connector-error.ts";
import type { _EdgeConnectorFrameBase } from "./edge-connector-frame.ts";
import type { EdgeConnectorHttpResponse } from "./edge-connector-http-response.ts";
import type { EdgeConnectorResponseFrameType } from "./edge-connector-response-frame-type.ts";

export type EdgeConnectorResponseFrame =
  & (Omit<
    & (_EdgeConnectorFrameBase)
    & ({
      type: EdgeConnectorResponseFrameType;
      requestId: string;
      response?: EdgeConnectorHttpResponse;
      error?: EdgeConnectorError;
    }),
    "type"
  >)
  & ({
    type: ("response") | ("response");
  });
