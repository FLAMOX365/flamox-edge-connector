import type { JsonValue } from "../sdk/extension.ts";
import type { ExtensionReleaseDescriptor } from "./extension-integrity.ts";
import type { ExtensionGrant } from "./extension-policy.ts";

export type ExtensionObservedStatus = "ACTIVE" | "DISABLED" | "ERROR";

export type InstalledExtensionRevision = {
  readonly managementMode: "MANAGED" | "LOCAL";
  readonly extensionId: string;
  readonly version: string;
  readonly packagePath: string;
  readonly release: ExtensionReleaseDescriptor;
  readonly grant: ExtensionGrant;
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly installedAt: string;
  readonly activatedAt: string | null;
};

export type InstalledExtensionState = InstalledExtensionRevision & {
  readonly status: ExtensionObservedStatus;
  readonly lastErrorCode: string | null;
  /** Previous verified revisions, newest first, available for atomic rollback. */
  readonly history?: readonly InstalledExtensionRevision[];
};

type ExtensionStateDocument = {
  readonly schemaVersion: 2;
  readonly extensions: readonly InstalledExtensionState[];
};

/** Persists non-secret observed extension state using atomic replacement. */
export class ExtensionStateStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<readonly InstalledExtensionState[]> {
    let text: string;
    try {
      const info = await Deno.stat(this.#path);
      if (!info.isFile || info.size > 5 * 1024 * 1024) {
        throw new Error("Extension state file is missing or too large.");
      }
      text = await Deno.readTextFile(this.#path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (
      !isRecord(parsed) ||
      (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) ||
      !Array.isArray(parsed.extensions)
    ) {
      throw new Error("Extension state file is invalid.");
    }
    const states = parsed.extensions.map((state) =>
      parseInstalledExtensionState(state, parsed.schemaVersion === 2)
    );
    const identifiers = states.map((state) => state.extensionId);
    if (new Set(identifiers).size !== identifiers.length) {
      throw new Error(
        "Extension state contains duplicate extension identifiers.",
      );
    }
    return states;
  }

  async save(extensions: readonly InstalledExtensionState[]): Promise<void> {
    const document: ExtensionStateDocument = {
      schemaVersion: 2,
      extensions: [...extensions].sort((left, right) =>
        left.extensionId.localeCompare(right.extensionId)
      ).map((state) => ({ ...state, history: state.history ?? [] })),
    };
    const slash = Math.max(
      this.#path.lastIndexOf("/"),
      this.#path.lastIndexOf("\\"),
    );
    const directory = slash < 0 ? "." : this.#path.slice(0, slash);
    await Deno.mkdir(directory, { recursive: true });
    const temporary = `${this.#path}.tmp-${crypto.randomUUID()}`;
    try {
      await Deno.writeTextFile(
        temporary,
        `${JSON.stringify(document, null, 2)}\n`,
        {
          createNew: true,
          mode: 0o600,
        },
      );
      await Deno.rename(temporary, this.#path);
    } catch (error) {
      try {
        await Deno.remove(temporary);
      } catch { /* preserve the original persistence failure */ }
      throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInstalledExtensionState(
  value: unknown,
  historyRequired: boolean,
): InstalledExtensionState {
  if (!isRecord(value)) invalidState();
  const requiredKeys = [
    "extensionId",
    "version",
    "packagePath",
    "status",
    "release",
    "grant",
    "configuration",
    "installedAt",
    "activatedAt",
    "lastErrorCode",
  ];
  exactKeys(
    value,
    historyRequired
      ? [...requiredKeys, "managementMode", "history"]
      : requiredKeys,
    historyRequired ? [] : ["managementMode", "history"],
  );
  const revision = parseInstalledExtensionRevision(value);
  const extensionId = revision.extensionId;
  if (
    value.status !== "ACTIVE" && value.status !== "DISABLED" &&
    value.status !== "ERROR"
  ) {
    invalidState();
  }
  const lastErrorCode = value.lastErrorCode === null
    ? null
    : requiredText(value.lastErrorCode);
  const historyValue = value.history ?? [];
  if (!Array.isArray(historyValue) || historyValue.length > 10) invalidState();
  const history = historyValue.map((nested) => {
    if (!isRecord(nested)) invalidState();
    exactKeys(nested, [
      "managementMode",
      "extensionId",
      "version",
      "packagePath",
      "release",
      "grant",
      "configuration",
      "installedAt",
      "activatedAt",
    ]);
    const parsed = parseInstalledExtensionRevision(nested);
    if (parsed.extensionId !== extensionId) invalidState();
    return parsed;
  });
  return {
    ...revision,
    status: value.status,
    lastErrorCode,
    history,
  };
}

function parseInstalledExtensionRevision(
  value: Record<string, unknown>,
): InstalledExtensionRevision {
  const managementMode = value.managementMode === undefined
    ? "LOCAL"
    : value.managementMode;
  if (managementMode !== "MANAGED" && managementMode !== "LOCAL") {
    invalidState();
  }
  const extensionId = requiredText(value.extensionId);
  const version = requiredText(value.version);
  const packagePath = requiredText(value.packagePath);
  if (
    packagePath.startsWith("/") || packagePath.startsWith("\\") ||
    packagePath.split(/[\\/]/u).some((segment) =>
      segment === ".." || segment === ""
    )
  ) invalidState();
  if (!isRecord(value.release)) invalidState();
  exactKeys(value.release, [
    "extensionId",
    "version",
    "digest",
    "publisher",
    "publisherKeyId",
    "signature",
  ]);
  const release: ExtensionReleaseDescriptor = {
    extensionId: requiredText(value.release.extensionId),
    version: requiredText(value.release.version),
    digest: requiredText(value.release.digest),
    publisher: requiredText(value.release.publisher),
    publisherKeyId: requiredText(value.release.publisherKeyId),
    signature: requiredText(value.release.signature),
  };
  if (
    release.extensionId !== extensionId || release.version !== version ||
    !/^sha256:[0-9a-f]{64}$/u.test(release.digest)
  ) invalidState();
  if (!isRecord(value.grant)) invalidState();
  exactKeys(value.grant, ["capabilities", "network", "secrets"]);
  const grant: ExtensionGrant = {
    capabilities: stringArray(value.grant.capabilities),
    network: stringArray(value.grant.network),
    secrets: stringArray(value.grant.secrets),
  };
  if (!isRecord(value.configuration) || !isJsonRecord(value.configuration)) {
    invalidState();
  }
  return {
    managementMode,
    extensionId,
    version,
    packagePath,
    release,
    grant,
    configuration: value.configuration,
    installedAt: dateTime(value.installedAt),
    activatedAt: value.activatedAt === null
      ? null
      : dateTime(value.activatedAt),
  };
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value);
  if (
    expected.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !expected.includes(key) && !optional.includes(key))
  ) {
    invalidState();
  }
}

function requiredText(value: unknown): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 10_000
  ) {
    invalidState();
  }
  return value;
}

function stringArray(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) || value.some((nested) => typeof nested !== "string")
  ) {
    invalidState();
  }
  const values = value as string[];
  if (new Set(values).size !== values.length) invalidState();
  return values;
}

function dateTime(value: unknown): string {
  const text = requiredText(value);
  if (Number.isNaN(Date.parse(text))) invalidState();
  return text;
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

function invalidState(): never {
  throw new Error("Extension state file is invalid.");
}
