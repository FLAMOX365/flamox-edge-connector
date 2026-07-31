/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />

import {
  type ExtensionDefinition,
  isExtensionDefinition,
  type JsonValue,
  type ShowMessageRequest,
  type ShowMessageResult,
} from "../sdk/extension.ts";
import type {
  ExtensionWorkerExecuteMessage,
  ExtensionWorkerInboundMessage,
  ExtensionWorkerOutboundMessage,
} from "./extension-worker-protocol.ts";

let extension: ExtensionDefinition | undefined;
let sendMessage:
  | ((message: ExtensionWorkerOutboundMessage) => void)
  | undefined;
const pendingHostCalls = new Map<
  string,
  {
    readonly executionId: string;
    readonly resolve: (value: JsonValue) => void;
    readonly reject: (reason: unknown) => void;
  }
>();

self.onmessage = (event: MessageEvent<{ type?: unknown }>) => {
  if (event.data?.type !== "connect" || event.ports.length !== 1) {
    return;
  }
  const port = event.ports[0];
  // Capture the native bound sender before importing extension code. The
  // extension never receives this private port and cannot forge lifecycle
  // messages through globalThis.postMessage or a replaced onmessage handler.
  sendMessage = port.postMessage.bind(port);
  port.onmessage = (message: MessageEvent<ExtensionWorkerInboundMessage>) => {
    void handleMessage(message.data);
  };
  port.start();
  self.onmessage = null;
};

async function handleMessage(
  message: ExtensionWorkerInboundMessage,
): Promise<void> {
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
  message: ExtensionWorkerExecuteMessage,
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
    | Extract<ExtensionWorkerInboundMessage, { type: "host-result" }>
    | Extract<ExtensionWorkerInboundMessage, { type: "host-error" }>,
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

function send(message: ExtensionWorkerOutboundMessage): void {
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
