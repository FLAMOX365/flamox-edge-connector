import type { JsonValue } from "../sdk/extension.ts";
import type { EncryptedConnectorSecret } from "./connector-identity.ts";
import type { ExtensionGrant } from "./extension-policy.ts";

export type DesiredExtensionStatus = "ACTIVE" | "DISABLED" | "ABSENT";

export type DesiredExtension = {
  readonly extensionId: string;
  readonly version?: string;
  readonly bundleUrl?: string;
  readonly status: DesiredExtensionStatus;
  readonly grant?: ExtensionGrant;
  readonly configuration?: Readonly<Record<string, JsonValue>>;
  readonly secrets: Readonly<Record<string, EncryptedConnectorSecret>>;
};

export type ConnectorDesiredState = {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly publisherTrust: unknown;
  readonly extensionPolicy: unknown;
  readonly extensions: readonly DesiredExtension[];
};

export type ConnectorCommand = {
  readonly sequence: number;
  readonly commandId: string;
  readonly extensionId: string;
  readonly action: string;
  readonly input: JsonValue;
  readonly expiresAt: string;
};

export type ConnectorCommandBatch = {
  readonly schemaVersion: 1;
  readonly commands: readonly ConnectorCommand[];
};

export function parseDesiredState(value: unknown): ConnectorDesiredState {
  const root = record(value, "Desired State");
  exactKeys(root, [
    "schemaVersion",
    "revision",
    "publisherTrust",
    "extensionPolicy",
    "extensions",
  ]);
  if (
    root.schemaVersion !== 1 || !Number.isSafeInteger(root.revision) ||
    Number(root.revision) < 0 || !Array.isArray(root.extensions)
  ) invalid("Desired State");
  const ids = new Set<string>();
  const extensions = root.extensions.map((nested, index) => {
    const extension = record(nested, `Desired extension ${index}`);
    exactKeys(
      extension,
      ["extensionId", "status", "secrets"],
      ["version", "bundleUrl", "grant", "configuration"],
    );
    const extensionId = identifier(extension.extensionId, "extensionId");
    if (ids.has(extensionId)) invalid("Desired State duplicate extension");
    ids.add(extensionId);
    if (
      extension.status !== "ACTIVE" && extension.status !== "DISABLED" &&
      extension.status !== "ABSENT"
    ) invalid("Desired extension status");
    const secrets = parseEncryptedSecrets(extension.secrets);
    if (extension.status === "ABSENT") {
      if (
        extension.version !== undefined || extension.bundleUrl !== undefined ||
        extension.grant !== undefined ||
        extension.configuration !== undefined ||
        Object.keys(secrets).length > 0
      ) invalid("Absent desired extension");
      return { extensionId, status: "ABSENT" as const, secrets };
    }
    if (
      typeof extension.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
        extension.version,
      ) || typeof extension.bundleUrl !== "string" ||
      !isRecord(extension.grant) || !isRecord(extension.configuration) ||
      !isJsonRecord(extension.configuration)
    ) invalid("Desired extension");
    return {
      extensionId,
      version: extension.version,
      bundleUrl: extension.bundleUrl,
      status: extension.status as "ACTIVE" | "DISABLED",
      grant: parseGrant(extension.grant),
      configuration: extension.configuration,
      secrets,
    };
  });
  return {
    schemaVersion: 1,
    revision: Number(root.revision),
    publisherTrust: root.publisherTrust,
    extensionPolicy: root.extensionPolicy,
    extensions,
  };
}

export function parseCommandBatch(value: unknown): ConnectorCommandBatch {
  const root = record(value, "Command batch");
  exactKeys(root, ["schemaVersion", "commands"]);
  if (root.schemaVersion !== 1 || !Array.isArray(root.commands)) {
    invalid("Command batch");
  }
  let previousSequence = -1;
  const commands = root.commands.map((nested, index) => {
    const command = record(nested, `Command ${index}`);
    exactKeys(command, [
      "sequence",
      "commandId",
      "extensionId",
      "action",
      "input",
      "expiresAt",
    ]);
    if (
      !Number.isSafeInteger(command.sequence) ||
      Number(command.sequence) <= previousSequence ||
      !isJsonValue(command.input)
    ) invalid(`Command ${index}`);
    previousSequence = Number(command.sequence);
    const expiresAt = text(command.expiresAt, "expiresAt", 100);
    if (Number.isNaN(Date.parse(expiresAt))) invalid(`Command ${index}`);
    return {
      sequence: Number(command.sequence),
      commandId: identifier(command.commandId, "commandId"),
      extensionId: identifier(command.extensionId, "extensionId"),
      action: identifier(command.action, "action"),
      input: command.input,
      expiresAt,
    };
  });
  return { schemaVersion: 1, commands };
}

function parseGrant(value: Record<string, unknown>): ExtensionGrant {
  exactKeys(value, ["capabilities", "network", "secrets"]);
  return {
    capabilities: stringArray(value.capabilities),
    network: stringArray(value.network),
    secrets: stringArray(value.secrets),
  };
}

function parseEncryptedSecrets(
  value: unknown,
): Readonly<Record<string, EncryptedConnectorSecret>> {
  const root = record(value, "Encrypted secrets");
  const result: Record<string, EncryptedConnectorSecret> = {};
  for (const [name, nested] of Object.entries(root)) {
    if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u.test(name)) invalid("Secret name");
    const envelope = record(nested, `Secret '${name}'`);
    exactKeys(envelope, ["algorithm", "ciphertext"]);
    if (
      envelope.algorithm !== "RSA-OAEP-256" ||
      typeof envelope.ciphertext !== "string" || !envelope.ciphertext
    ) invalid(`Secret '${name}'`);
    result[name] = {
      algorithm: "RSA-OAEP-256",
      ciphertext: envelope.ciphertext,
    };
  }
  return result;
}

function stringArray(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) || value.some((nested) => typeof nested !== "string")
  ) {
    invalid("String array");
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) invalid("String array");
  return result;
}

function identifier(value: unknown, label: string): string {
  const result = text(value, label, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(result)) invalid(label);
  return result;
}

function text(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > maximum
  ) invalid(label);
  return value;
}

function isJsonRecord(
  value: Record<string, unknown>,
): value is Record<string, JsonValue> {
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && isJsonRecord(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) invalid("Object");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(label);
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(label: string): never {
  throw new Error(`${label} is invalid.`);
}
