import type { EdgeConnectorHeartbeatFrame } from "./edge-connector-heartbeat-frame.ts";
import type { EdgeConnectorRequestFrame } from "./edge-connector-request-frame.ts";
import type { EdgeConnectorResponseFrame } from "./edge-connector-response-frame.ts";

type EdgeConnectorFrameDiscriminator =
  | ("request")
  | ("response")
  | ("heartbeat");

export type _EdgeConnectorFrameBase = {
  type: string;
};

export type EdgeConnectorFrame<
  TType extends EdgeConnectorFrameDiscriminator =
    EdgeConnectorFrameDiscriminator,
> =
  & (_EdgeConnectorFrameBase)
  & (({
    request:
      & ({
        type: "request";
      })
      & (EdgeConnectorRequestFrame);
    response:
      & ({
        type: "response";
      })
      & (EdgeConnectorResponseFrame);
    heartbeat:
      & ({
        type: "heartbeat";
      })
      & (EdgeConnectorHeartbeatFrame);
  })[TType]);
