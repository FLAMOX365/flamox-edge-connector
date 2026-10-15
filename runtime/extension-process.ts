import { createInterface } from "node:readline";
import { writeSync } from "node:fs";
import { format } from "node:util";
import http from "node:http";
import https from "node:https";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

for (const method of ["log", "info", "warn", "error", "debug"] as const)
  console[method] = (...values: unknown[]) => {
    process.stderr.write(`${format(...values)}\n`);
  };

// Customer-local destinations must use the authenticated grant-filtered proxy,
// including loopback/private addresses. Direct sockets remain denied by the OS.
process.env.NO_PROXY = "";
process.env.no_proxy = "";
for (const name of [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
]) {
  const value = process.env[name];
  if (!value) continue;
  const url = new URL(value);
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  process.env[name] = url.href;
}
http.globalAgent = new http.Agent({ keepAlive: true, proxyEnv: process.env });
https.globalAgent = new https.Agent({ keepAlive: true, proxyEnv: process.env });
setGlobalDispatcher(
  new EnvHttpProxyAgent({
    httpProxy: process.env.HTTP_PROXY,
    httpsProxy: process.env.HTTPS_PROXY,
    noProxy: "",
  }),
);

import {
  type ExtensionDefinition,
  isExtensionDefinition,
  type JsonValue,
  type ShowMessageRequest,
  type ShowMessageResult,
} from "@edge-connector/sdk/extension";
import type {
  ExtensionExecuteMessage,
  ExtensionInboundMessage,
  ExtensionOutboundMessage,
} from "./extension-messages.ts";

let extension: ExtensionDefinition | undefined;
let sendMessage: ((message: ExtensionOutboundMessage) => void) | undefined;
const pendingHostCalls = new Map<
  string,
  {
    readonly executionId: string;
    readonly resolve: (value: JsonValue) => void;
    readonly reject: (reason: unknown) => void;
  }
>();

// A dedicated protocol descriptor keeps console output out of the host protocol.
// OS isolation controls authority even if extension code writes its own process.
sendMessage = (message) => {
  const line = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(line) > 16 * 1024 * 1024)
    throw new Error("Extension response exceeds the protocol limit.");
  writeSync(process.platform === "win32" ? 1 : 3, line);
};
let bufferedBytes = 0;
process.stdin.on("data", (chunk: Buffer) => {
  bufferedBytes += chunk.length;
  if (bufferedBytes > 16 * 1024 * 1024) process.exit(1);
});
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  bufferedBytes = 0;
  try {
    void handleMessage(JSON.parse(line) as ExtensionInboundMessage);
  } catch {
    process.exit(1);
  }
});
lines.once("close", () => process.exit(0));

async function handleMessage(message: ExtensionInboundMessage): Promise<void> {
  if (message.type === "init") {
    await initialize(message.entrypointUrl, message.expectedActions);
    return;
  }
  if (message.type === "host-result" || message.type === "host-error") {
    handleHostResponse(message);
    return;
  }
  if (!extension) {
    sendError(
      message.executionId,
      "EXTENSION_NOT_READY",
      "Extension is not ready.",
    );
    return;
  }
  await execute(extension, message);
}

async function initialize(
  entrypointUrl: string,
  expectedActions: readonly string[],
): Promise<void> {
  try {
    const loaded: unknown = await import(entrypointUrl);
    const definition = isRecord(loaded) ? loaded.default : undefined;
    if (!isExtensionDefinition(definition)) {
      throw new Error(
        "Entrypoint default export is not an extension definition.",
      );
    }
    const actualActions = Object.keys(definition.actions).sort();
    const expected = [...expectedActions].sort();
    if (
      actualActions.length !== expected.length ||
      actualActions.some((action, index) => action !== expected[index])
    ) {
      throw new Error("Entrypoint actions do not match the signed manifest.");
    }
    extension = definition;
    send({ type: "ready", actions: actualActions });
  } catch (error) {
    sendError(
      null,
      "EXTENSION_INITIALIZATION_FAILED",
      "Extension initialization failed.",
      error,
    );
  }
}

async function execute(
  definition: ExtensionDefinition,
  message: ExtensionExecuteMessage,
): Promise<void> {
  const handler = definition.actions[message.action];
  if (!handler) {
    sendError(
      message.executionId,
      "EXTENSION_ACTION_NOT_FOUND",
      "Extension action was not found.",
    );
    return;
  }
  try {
    const output = await handler(
      {
        requestId: message.requestId,
        configuration: message.configuration,
        secrets: message.secrets,
        host: {
          ui: {
            showMessage: (request: ShowMessageRequest) =>
              callHost(
                message.executionId,
                "host.ui.message-box",
                "show-message",
                request as unknown as JsonValue,
              ) as Promise<ShowMessageResult>,
          },
        },
      },
      message.input,
    );
    if (!isJsonValue(output)) {
      throw new Error("Extension action returned a non-JSON value.");
    }
    send({ type: "result", executionId: message.executionId, output });
  } catch (error) {
    sendError(
      message.executionId,
      "EXTENSION_ACTION_FAILED",
      "Extension action failed.",
      error,
    );
  }
}

function callHost(
  executionId: string,
  capability: string,
  operation: string,
  input: JsonValue,
): Promise<JsonValue> {
  const callId = crypto.randomUUID();
  const result = new Promise<JsonValue>((resolve, reject) => {
    pendingHostCalls.set(callId, { executionId, resolve, reject });
  });
  send({
    type: "host-call",
    executionId,
    callId,
    capability,
    operation,
    input,
  });
  return result;
}

function handleHostResponse(
  message:
    | Extract<ExtensionInboundMessage, { type: "host-result" }>
    | Extract<ExtensionInboundMessage, { type: "host-error" }>,
): void {
  const pending = pendingHostCalls.get(message.callId);
  if (!pending || pending.executionId !== message.executionId) {
    return;
  }
  pendingHostCalls.delete(message.callId);
  if (message.type === "host-result") {
    pending.resolve(message.output);
    return;
  }
  pending.reject(new Error(`${message.code}: ${message.message}`));
}

function sendError(
  executionId: string | null,
  code: string,
  message: string,
  error?: unknown,
): void {
  send({
    type: "error",
    executionId,
    code,
    message,
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
}

function send(message: ExtensionOutboundMessage): void {
  if (!sendMessage) {
    throw new Error("Extension worker control channel is not connected.");
  }
  sendMessage(message);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
