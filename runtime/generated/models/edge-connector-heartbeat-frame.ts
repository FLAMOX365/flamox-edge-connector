// Generated from OpenAPI schemas. Do not edit manually.

import type { _EdgeConnectorFrameBase } from "./edge-connector-frame.ts";
import type { EdgeConnectorHeartbeatFrameType } from "./edge-connector-heartbeat-frame-type.ts";

export type EdgeConnectorHeartbeatFrame = _EdgeConnectorFrameBase & {
  type: EdgeConnectorHeartbeatFrameType;
  sentAt?: string;
};
