import { createAdaptorServer } from "@hono/node-server";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export type HttpServer = {
  readonly finished: Promise<void>;
  readonly port: number;
  shutdown(): Promise<void>;
};

/** Adapts the existing Fetch contract to Node's listener and upgrade lifecycle. */
export async function serveHttp(
  options: { hostname: string; port: number; signal: AbortSignal },
  handler: (request: Request) => Response | Promise<Response>,
  onWebSocket: (socket: WebSocket) => void,
): Promise<HttpServer> {
  const server = createAdaptorServer({ fetch: handler }) as Server;
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
  });
  server.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/ws") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, onWebSocket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.hostname, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const finished = new Promise<void>((resolve, reject) => {
    server.once("close", resolve);
    server.once("error", reject);
  });
  // A close can happen while supervision is entering its next await.
  void finished.catch(() => undefined);
  const shutdown = async () => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  const abort = () => {
    void shutdown().catch(() => undefined);
  };
  options.signal.addEventListener("abort", abort, { once: true });
  void finished
    .finally(() => options.signal.removeEventListener("abort", abort))
    .catch(() => undefined);
  if (options.signal.aborted) abort();
  return { finished, port: (server.address() as AddressInfo).port, shutdown };
}
