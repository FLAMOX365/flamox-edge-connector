/**
 * Shared, mutable status of the cloud connection and the supervision loop.
 *
 * Owned by main.ts and passed to both the WebSocket client (which updates it)
 * and the HTTP handler (which reads it for the /health and /ready probes). This
 * keeps the connection-state truth in one place without coupling
 * {@link ConnectorRuntime} to liveness concerns.
 */
export type ConnectionState = "connecting" | "open" | "disconnected";

export type RuntimeStatus = {
  /** Current state of the outbound cloud WebSocket. */
  connectionState: ConnectionState;
  /** Epoch ms of the last successful WebSocket open, or null if never opened. */
  lastConnectedAt: number | null;
  /** Epoch ms of the last inbound frame (proof of peer liveness), or null. */
  lastInboundAt: number | null;
  /**
   * Epoch ms of the last sign of life from the supervision subsystem: a
   * reconnect-loop iteration, a heartbeat tick, or an inbound frame. /health
   * (liveness) fails only when this goes stale, i.e. the in-process recovery
   * itself has wedged.
   */
  lastTickAt: number;
  /** Current consecutive reconnect attempt counter (observability only). */
  reconnectAttempt: number;
};

export function createRuntimeStatus(now: number = Date.now()): RuntimeStatus {
  return {
    connectionState: "disconnected",
    lastConnectedAt: null,
    lastInboundAt: null,
    lastTickAt: now,
    reconnectAttempt: 0,
  };
}
