import type { _EdgeConnectorFrameBase } from "./edge-connector-frame.ts";
import type { EdgeConnectorHeartbeatFrameType } from "./edge-connector-heartbeat-frame-type.ts";

export type EdgeConnectorHeartbeatFrame =
  & (Omit<
    & (_EdgeConnectorFrameBase)
    & ({
      type: EdgeConnectorHeartbeatFrameType;
      sentAt?: string;
    }),
    "type"
  >)
  & ({
    type: ("heartbeat") | ("heartbeat");
  });
