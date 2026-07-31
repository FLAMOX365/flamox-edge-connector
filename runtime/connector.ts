import type {
  EdgeConnectorHttpResponse,
  EdgeConnectorMessageFrame,
  EdgeConnectorRequestFrame,
} from "./generated/models.ts";
import type { RuntimeLogger } from "./logger.ts";
import { createLogger } from "./logger.ts";
import type { WritableFrame } from "./protocol.ts";
import {
  createErrorFrame,
  createHeartbeatFrame,
  createResponseFrame,
  isHeartbeatFrame,
  isRequestFrame,
  parseMessageFrame,
  serializeFrame,
} from "./protocol.ts";
import { toEdgeConnectorError } from "./runtime-error.ts";

export type FrameSender = (frame: WritableFrame) => void | Promise<void>;

/**
 * Handles inbound protocol frames and returns the response to send back.
 * The current wire contract is HTTP-only, but the runtime boundary is named
 * around protocol execution so additional protocol families can plug in later
 * without pretending to be HTTP functions.
 */
export interface ProtocolExecutor {
  execute(
    frame: EdgeConnectorRequestFrame,
  ): Promise<EdgeConnectorHttpResponse>;
}

export type ConnectorRuntimeOptions = {
  /** Protocol executor that handles inbound request frames. */
  protocolExecutor: ProtocolExecutor;
  logger?: RuntimeLogger;
};

export class ConnectorRuntime {
  private readonly logger: RuntimeLogger;

  constructor(private readonly options: ConnectorRuntimeOptions) {
    this.logger = options.logger ?? createLogger();
  }

  async handleFrame(
    frame: EdgeConnectorMessageFrame,
    send: FrameSender,
  ): Promise<void> {
    if (isHeartbeatFrame(frame)) {
      this.logger.info("Received heartbeat frame; sending heartbeat response");
      await send(createHeartbeatFrame());
      return;
    }

    if (!isRequestFrame(frame)) {
      this.logger.warn(
        `Ignoring unsupported inbound frame type: ${frame.type}`,
      );
      return;
    }

    await this.handleRequestFrame(frame, send);
  }

  attachWebSocket(socket: WebSocket): void {
    socket.addEventListener("message", (event) => {
      void this.handleSocketMessage(
        event.data,
        (frame) => socket.send(serializeFrame(frame)),
      ).catch((error) => {
        this.logger.error("Failed to process WebSocket message", error);
      });
    });

    socket.addEventListener("open", () => {
      this.logger.info("Edge Connector WebSocket opened");
    });

    socket.addEventListener("close", (e) => {
      this.logger.warn("Edge Connector WebSocket closed", {
        code: e.code,
        reason: e.reason,
      });
    });
  }

  private async handleSocketMessage(
    data: unknown,
    send: FrameSender,
  ): Promise<void> {
    let frame: EdgeConnectorMessageFrame;
    try {
      frame = parseMessageFrame(data);
    } catch (error) {
      this.logger.warn(toEdgeConnectorError(error).message);
      return;
    }

    await this.handleFrame(frame, send);
  }

  private async handleRequestFrame(
    frame: EdgeConnectorRequestFrame,
    send: FrameSender,
  ): Promise<void> {
    try {
      const response = await this.options.protocolExecutor.execute(frame);
      await send(createResponseFrame(frame.requestId, response));
    } catch (error) {
      this.logger.error(`Protocol request '${frame.requestId}' failed`, error);
      await send(
        createErrorFrame(frame.requestId, toEdgeConnectorError(error)),
      );
    }
  }
}
