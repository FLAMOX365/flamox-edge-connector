import type { JsonValue } from "../sdk/extension.ts";

export type ExtensionWorkerInitMessage = {
  readonly type: "init";
  readonly entrypointUrl: string;
  readonly expectedActions: readonly string[];
};

export type ExtensionWorkerExecuteMessage = {
  readonly type: "execute";
  readonly executionId: string;
  readonly requestId: string;
  readonly action: string;
  readonly input: JsonValue;
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly secrets: Readonly<Record<string, string>>;
};

export type ExtensionWorkerHostResultMessage = {
  readonly type: "host-result";
  readonly executionId: string;
  readonly callId: string;
  readonly output: JsonValue;
};

export type ExtensionWorkerHostErrorMessage = {
  readonly type: "host-error";
  readonly executionId: string;
  readonly callId: string;
  readonly code: string;
  readonly message: string;
};

export type ExtensionWorkerInboundMessage =
  | ExtensionWorkerInitMessage
  | ExtensionWorkerExecuteMessage
  | ExtensionWorkerHostResultMessage
  | ExtensionWorkerHostErrorMessage;

export type ExtensionWorkerReadyMessage = {
  readonly type: "ready";
  readonly actions: readonly string[];
};

export type ExtensionWorkerResultMessage = {
  readonly type: "result";
  readonly executionId: string;
  readonly output: JsonValue;
};

export type ExtensionWorkerErrorMessage = {
  readonly type: "error";
  readonly executionId: string | null;
  readonly code: string;
  readonly message: string;
  readonly errorName: string;
};

export type ExtensionWorkerHostCallMessage = {
  readonly type: "host-call";
  readonly executionId: string;
  readonly callId: string;
  readonly capability: string;
  readonly operation: string;
  readonly input: JsonValue;
};

export type ExtensionWorkerOutboundMessage =
  | ExtensionWorkerReadyMessage
  | ExtensionWorkerResultMessage
  | ExtensionWorkerErrorMessage
  | ExtensionWorkerHostCallMessage;
