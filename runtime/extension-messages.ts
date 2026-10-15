import type { JsonValue } from "@edge-connector/sdk/extension";

export type ExtensionInitMessage = {
  readonly type: "init";
  readonly entrypointUrl: string;
  readonly expectedActions: readonly string[];
};

export type ExtensionExecuteMessage = {
  readonly type: "execute";
  readonly executionId: string;
  readonly requestId: string;
  readonly action: string;
  readonly input: JsonValue;
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly secrets: Readonly<Record<string, string>>;
};

export type ExtensionHostResultMessage = {
  readonly type: "host-result";
  readonly executionId: string;
  readonly callId: string;
  readonly output: JsonValue;
};

export type ExtensionHostErrorMessage = {
  readonly type: "host-error";
  readonly executionId: string;
  readonly callId: string;
  readonly code: string;
  readonly message: string;
};

export type ExtensionInboundMessage =
  | ExtensionInitMessage
  | ExtensionExecuteMessage
  | ExtensionHostResultMessage
  | ExtensionHostErrorMessage;

export type ExtensionReadyMessage = {
  readonly type: "ready";
  readonly actions: readonly string[];
};

export type ExtensionResultMessage = {
  readonly type: "result";
  readonly executionId: string;
  readonly output: JsonValue;
};

export type ExtensionErrorMessage = {
  readonly type: "error";
  readonly executionId: string | null;
  readonly code: string;
  readonly message: string;
  readonly errorName: string;
};

export type ExtensionHostCallMessage = {
  readonly type: "host-call";
  readonly executionId: string;
  readonly callId: string;
  readonly capability: string;
  readonly operation: string;
  readonly input: JsonValue;
};

export type ExtensionOutboundMessage =
  | ExtensionReadyMessage
  | ExtensionResultMessage
  | ExtensionErrorMessage
  | ExtensionHostCallMessage;
