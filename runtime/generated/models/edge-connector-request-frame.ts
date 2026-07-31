import type { _EdgeConnectorFrameBase } from "./edge-connector-frame.ts";
import type { EdgeConnectorHttpRequest } from "./edge-connector-http-request.ts";
import type { EdgeConnectorRequestFrameType } from "./edge-connector-request-frame-type.ts";

export type EdgeConnectorRequestFrame =
  & (Omit<
    & (_EdgeConnectorFrameBase)
    & ({
      type: EdgeConnectorRequestFrameType;
      requestId: string;
      request: EdgeConnectorHttpRequest;
    }),
    "type"
  >)
  & ({
    type: ("request") | ("request");
  });
