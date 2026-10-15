import { createInterface } from "node:readline";
import { format } from "node:util";
import { DesktopConnectorController } from "./controller.ts";
import type { InstallBundleInput, ExecuteActionInput } from "./contracts.ts";
import type {
  ShowMessageRequest,
  ShowMessageResult,
} from "@edge-connector/sdk/extension";

const write = process.stdout.write.bind(process.stdout);
for (const method of ["log", "info", "warn", "error", "debug"] as const)
  console[method] = (...values: unknown[]) => {
    process.stderr.write(`${format(...values)}\n`);
  };
const maximumFrameBytes = 220 * 1024 * 1024;
const pendingDialogs = new Map<
  string,
  {
    resolve: (value: ShowMessageResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
let invalidationPending = false;
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--settings"))
  throw new Error("Usage: desktop/main.js [--settings <path>]");
const controller = await DesktopConnectorController.create(args[1], {
  onStateChanged: () => {
    if (invalidationPending) return;
    invalidationPending = true;
    queueMicrotask(() => {
      invalidationPending = false;
      send({ type: "state-changed" });
    });
  },
  messageBox: {
    show: async (request: ShowMessageRequest) => {
      await new Promise<ShowMessageResult>((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          pendingDialogs.delete(id);
          reject(new Error("Native message dialog timed out."));
        }, 30_000);
        pendingDialogs.set(id, { resolve, reject, timer });
        send({ type: "ui-request", id, request });
      });
    },
  },
});
let queued = Promise.resolve();
let bufferedBytes = 0;
process.stdin.on("data", (chunk: Buffer) => {
  bufferedBytes += chunk.length;
  if (bufferedBytes > maximumFrameBytes) void shutdown();
});
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  bufferedBytes = 0;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    void shutdown();
    return;
  }
  if (!isRecord(value)) return void shutdown();
  if (value.type === "ui-result" && typeof value.id === "string") {
    const pending = pendingDialogs.get(value.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingDialogs.delete(value.id);
    if (value.displayed === true) pending.resolve({ displayed: true });
    else pending.reject(new Error("Native dialog was not displayed."));
    return;
  }
  if (
    value.type !== "request" ||
    typeof value.id !== "string" ||
    typeof value.method !== "string" ||
    !Array.isArray(value.args) ||
    value.args.length > 4
  )
    return void shutdown();
  const id = value.id,
    method = value.method,
    args = value.args;
  queued = queued.then(async () => {
    try {
      send({ type: "response", id, result: await dispatch(method, args) });
    } catch (error) {
      send({
        type: "response",
        id,
        error:
          error instanceof Error ? error.message : "Desktop operation failed.",
      });
    }
  });
});
lines.once("close", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

async function dispatch(method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case "getState":
      return controller.state();
    case "saveSettings":
      return controller.saveSettings(args[0]);
    case "connectManaged":
      return controller.connect(args[0]);
    case "startConnector":
      return controller.start();
    case "stopConnector":
      return controller.stop();
    case "installBundle": {
      const input = object(args[0]);
      return controller.installBundle({
        bytes: bytes(input.bytes, 150 * 1024 * 1024),
        grant: input.grant,
        configuration: input.configuration,
        activate: input.activate === true,
      } satisfies InstallBundleInput);
    }
    case "reconfigureExtension":
      return controller.reconfigure(text(args[0]), args[1], args[2]);
    case "activateExtension":
      return controller.activate(text(args[0]));
    case "disableExtension":
      return controller.disable(text(args[0]));
    case "rollbackExtension":
      return controller.rollback(
        text(args[0]),
        args[1] === undefined || args[1] === null ? undefined : text(args[1]),
      );
    case "uninstallExtension":
      return controller.uninstall(text(args[0]));
    case "executeAction": {
      const input = object(args[0]);
      return controller.execute({
        extensionId: text(input.extensionId),
        action: text(input.action),
        input: input.input,
      } as ExecuteActionInput);
    }
    case "digestExtension":
      return controller.digest(text(args[0]));
    case "generatePublisherKey":
      return controller.generatePublisher(text(args[0]), text(args[1]));
    case "signExtension":
      return controller.sign(
        text(args[0]),
        bytes(args[1], 1024 * 1024),
        text(args[2]),
      );
    case "packExtension":
      return controller.pack(text(args[0]), args[1]);
    case "clearLogs":
      return controller.clearLogs();
    default:
      throw new Error("Unknown desktop operation.");
  }
}
function send(value: unknown): void {
  const line = `${JSON.stringify(value, (_name, nested: unknown) => (nested instanceof Uint8Array ? { encoding: "base64", data: Buffer.from(nested).toString("base64") } : nested))}\n`;
  if (Buffer.byteLength(line) > maximumFrameBytes)
    throw new Error("Desktop response exceeds the transport limit.");
  write(line);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object.");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a text argument.");
  return value;
}
function bytes(value: unknown, maximum: number): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(maximum / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  )
    throw new Error("Invalid binary argument.");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length > maximum)
    throw new Error("Binary argument exceeds its limit.");
  return decoded;
}
async function shutdown(): Promise<void> {
  for (const pending of pendingDialogs.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Desktop closed."));
  }
  pendingDialogs.clear();
  await controller.stop();
  process.exit(0);
}
