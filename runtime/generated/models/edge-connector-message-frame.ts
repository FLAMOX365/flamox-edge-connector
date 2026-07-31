import type { EdgeConnectorHeartbeatFrame } from "./edge-connector-heartbeat-frame.ts";
import type { EdgeConnectorRequestFrame } from "./edge-connector-request-frame.ts";
import type { EdgeConnectorResponseFrame } from "./edge-connector-response-frame.ts";

type EdgeConnectorMessageFrameDiscriminator =
  | ("request")
  | ("response")
  | ("heartbeat");

export type _EdgeConnectorMessageFrameBase =
  | (EdgeConnectorRequestFrame)
  | (EdgeConnectorResponseFrame)
  | (EdgeConnectorHeartbeatFrame);

export type EdgeConnectorMessageFrame<
  TType extends EdgeConnectorMessageFrameDiscriminator =
    EdgeConnectorMessageFrameDiscriminator,
> =
  & (_EdgeConnectorMessageFrameBase)
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
