/** JSON values accepted at the extension boundary. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type MessageBoxKind = "info" | "warning" | "error";

export type ShowMessageRequest = {
  readonly title: string;
  readonly message: string;
  readonly kind?: MessageBoxKind;
};

export type ShowMessageResult = {
  readonly displayed: true;
};

/** Brokered host functions. The connector authorizes every invocation. */
export type ExtensionHost = {
  readonly ui: {
    showMessage(request: ShowMessageRequest): Promise<ShowMessageResult>;
  };
};

/** Context supplied to one isolated extension action. */
export type ExtensionActionContext = {
  readonly requestId: string;
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly host: ExtensionHost;
};

/** One executable action exported by an extension. */
export type ExtensionActionHandler = (
  context: ExtensionActionContext,
  input: JsonValue,
) => JsonValue | Promise<JsonValue>;

/** Runtime entrypoint contract loaded inside an isolated worker. */
export type ExtensionDefinition = {
  readonly actions: Readonly<Record<string, ExtensionActionHandler>>;
};

/** Defines a worker extension while preserving inferred action types. */
export function defineExtension<const TDefinition extends ExtensionDefinition>(
  definition: TDefinition,
): TDefinition {
  return definition;
}

/** Runtime guard used before accepting an extension module. */
export function isExtensionDefinition(
  value: unknown,
): value is ExtensionDefinition {
  if (!isRecord(value) || !isRecord(value.actions)) {
    return false;
  }

  return Object.values(value.actions).every(
    (action) => typeof action === "function",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
