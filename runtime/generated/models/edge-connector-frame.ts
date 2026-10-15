// Generated from OpenAPI schemas. Do not edit manually.

import type { EdgeConnectorHeartbeatFrame } from "./edge-connector-heartbeat-frame.ts";
import type { EdgeConnectorRequestFrame } from "./edge-connector-request-frame.ts";
import type { EdgeConnectorResponseFrame } from "./edge-connector-response-frame.ts";

export type _EdgeConnectorFrameBase = {
  type: string;
};

type EdgeConnectorFrameDiscriminator = "request" | "response" | "heartbeat";

export type EdgeConnectorFrame<
  TType extends
    EdgeConnectorFrameDiscriminator = EdgeConnectorFrameDiscriminator,
> = _EdgeConnectorFrameBase &
  {
    request: { type: "request" } & EdgeConnectorRequestFrame;
    response: { type: "response" } & EdgeConnectorResponseFrame;
    heartbeat: { type: "heartbeat" } & EdgeConnectorHeartbeatFrame;
  }[TType];
