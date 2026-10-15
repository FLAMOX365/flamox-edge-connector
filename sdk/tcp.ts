import { SocksClient } from "socks";
import type { Socket } from "node:net";

/** Connects through the extension's authenticated, grant-filtered SOCKS proxy. */
export async function connectTcp(
  hostname: string,
  port: number,
  timeoutMilliseconds = 30_000,
): Promise<Socket> {
  if (
    !hostname ||
    hostname.includes("\0") ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("Invalid TCP destination.");
  const configured = process.env.ALL_PROXY ?? process.env.all_proxy;
  if (!configured)
    throw new Error("The extension network proxy is unavailable.");
  const proxy = new URL(configured);
  // SRT advertises its HTTP/SOCKS multiplexer as http:// in ALL_PROXY.
  if (
    !["http:", "socks5:", "socks5h:"].includes(proxy.protocol) ||
    !proxy.username ||
    !proxy.password
  )
    throw new Error("The extension network proxy is not authenticated.");
  const result = await SocksClient.createConnection({
    proxy: {
      host: proxy.hostname,
      port: Number(proxy.port),
      type: 5,
      userId: decodeURIComponent(proxy.username),
      password: decodeURIComponent(proxy.password),
    },
    command: "connect",
    destination: { host: hostname, port },
    timeout: timeoutMilliseconds,
  });
  return result.socket;
}
