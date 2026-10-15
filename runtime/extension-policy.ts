import * as fs from "node:fs/promises";
import type { JsonValue } from "@edge-connector/sdk/extension";
import type { ExtensionManifest } from "./extension-manifest.ts";

export type ExtensionGrant = {
  readonly capabilities: readonly string[];
  readonly network: readonly string[];
  readonly secrets: readonly string[];
};

export interface ExtensionPolicy {
  authorize(
    manifest: ExtensionManifest,
    grant: ExtensionGrant,
    configuration?: Readonly<Record<string, JsonValue>>,
  ): void;
}

export function parseExtensionGrant(value: unknown): ExtensionGrant {
  if (!isRecord(value)) {
    throw new Error("Extension grant must be an object.");
  }
  const keys = Object.keys(value);
  const expected = ["capabilities", "network", "secrets"];
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error("Extension grant contains unexpected or missing fields.");
  }
  return {
    capabilities: stringArray(value.capabilities, "grant capabilities"),
    network: stringArray(value.network, "grant network"),
    secrets: stringArray(value.secrets, "grant secrets"),
  };
}

export type ExtensionPolicyRule = {
  readonly extensionId: string;
  readonly publishers: readonly string[];
  readonly capabilities: readonly string[];
  readonly network: readonly string[];
  readonly allowConfiguredNetwork?: boolean;
  readonly secrets: readonly string[];
};

/**
 * Local, fail-closed policy. Cloud-side approval can only narrow these grants;
 * it can never expand what the customer installation permits.
 */
export class StaticExtensionPolicy implements ExtensionPolicy {
  readonly #rules: ReadonlyMap<string, ExtensionPolicyRule>;

  constructor(rules: readonly ExtensionPolicyRule[]) {
    const indexed = new Map<string, ExtensionPolicyRule>();
    for (const rule of rules) {
      if (indexed.has(rule.extensionId)) {
        throw new Error(
          `Extension policy rule '${rule.extensionId}' is duplicated.`,
        );
      }
      indexed.set(rule.extensionId, rule);
    }
    this.#rules = indexed;
  }

  static denyAll(): StaticExtensionPolicy {
    return new StaticExtensionPolicy([]);
  }

  static async fromFile(path: string): Promise<StaticExtensionPolicy> {
    let parsed: unknown;
    try {
      const info = await fs.stat(path);
      if (!info.isFile() || info.size > 1024 * 1024) {
        throw new Error("Extension policy is missing or too large.");
      }
      parsed = JSON.parse(await fs.readFile(path, "utf8"));
    } catch (error) {
      throw new Error(`Unable to read extension policy from '${path}'.`, {
        cause: error,
      });
    }
    return new StaticExtensionPolicy(parsePolicyRules(parsed));
  }

  authorize(
    manifest: ExtensionManifest,
    grant: ExtensionGrant,
    configuration: Readonly<Record<string, JsonValue>> = {},
  ): void {
    assertExactGrant("capabilities", manifest.capabilities, grant.capabilities);
    const configuredNetwork = resolveConfiguredNetworkTargets(
      manifest,
      configuration,
    );
    assertExactGrant(
      "network",
      [...manifest.permissions.network, ...configuredNetwork],
      grant.network,
    );
    assertExactGrant("secrets", manifest.permissions.secrets, grant.secrets);

    const rule = this.#rules.get(manifest.id);
    if (!rule) {
      throw new Error(
        `Local policy does not authorize extension '${manifest.id}'.`,
      );
    }
    if (!rule.publishers.includes(manifest.publisher)) {
      throw new Error(
        `Local policy does not authorize publisher '${manifest.publisher}' for '${manifest.id}'.`,
      );
    }
    assertAllowed(
      "capability",
      grant.capabilities,
      rule.capabilities,
      manifest.id,
    );
    const configuredSet = new Set(configuredNetwork);
    const deniedNetwork = grant.network.filter(
      (target) =>
        !rule.network.includes(target) &&
        !(rule.allowConfiguredNetwork && configuredSet.has(target)),
    );
    if (deniedNetwork.length > 0) {
      throw new Error(
        `Local policy denies network target${
          deniedNetwork.length === 1 ? "" : "s"
        } ${deniedNetwork.join(", ")} for '${manifest.id}'.`,
      );
    }
    assertAllowed("secret", grant.secrets, rule.secrets, manifest.id);
  }
}

export function parsePolicyRules(
  value: unknown,
): readonly ExtensionPolicyRule[] {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.extensions)
  ) {
    throw new Error("Extension policy must use schemaVersion 1.");
  }
  assertKeys(
    value,
    ["schemaVersion", "extensions"],
    ["$schema"],
    "Extension policy",
  );
  return value.extensions.map((nested, index) => {
    if (!isRecord(nested) || typeof nested.extensionId !== "string") {
      throw new Error(`Extension policy rule ${index} is invalid.`);
    }
    assertKeys(
      nested,
      ["extensionId", "publishers", "capabilities", "network", "secrets"],
      ["allowConfiguredNetwork"],
      `Extension policy rule ${index}`,
    );
    return {
      extensionId: nested.extensionId,
      publishers: stringArray(nested.publishers, `rule ${index} publishers`),
      capabilities: stringArray(
        nested.capabilities,
        `rule ${index} capabilities`,
      ),
      network: stringArray(nested.network, `rule ${index} network`),
      allowConfiguredNetwork:
        nested.allowConfiguredNetwork === undefined
          ? false
          : booleanValue(
              nested.allowConfiguredNetwork,
              `rule ${index} allowConfiguredNetwork`,
            ),
      secrets: stringArray(nested.secrets, `rule ${index} secrets`),
    };
  });
}

/**
 * Receives tenant-scoped rules from authenticated Desired State. An optional
 * local policy remains an additional customer-owned restriction.
 */
export class ManagedExtensionPolicy implements ExtensionPolicy {
  readonly #local?: StaticExtensionPolicy;
  #managed = StaticExtensionPolicy.denyAll();

  constructor(local?: StaticExtensionPolicy) {
    this.#local = local;
  }

  updateManagedRules(value: unknown): void {
    this.#managed = new StaticExtensionPolicy(parsePolicyRules(value));
  }

  authorize(
    manifest: ExtensionManifest,
    grant: ExtensionGrant,
    configuration: Readonly<Record<string, JsonValue>> = {},
  ): void {
    this.#managed.authorize(manifest, grant, configuration);
    this.#local?.authorize(manifest, grant, configuration);
  }
}

export function resolveConfiguredNetworkTargets(
  manifest: ExtensionManifest,
  configuration: Readonly<Record<string, JsonValue>>,
): readonly string[] {
  const targets = manifest.permissions.configuredNetwork.map((permission) => {
    const value = jsonPointer(configuration, permission.configurationPointer);
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(
        `Configured network value '${permission.configurationPointer}' must be a URL or host.`,
      );
    }
    const raw = value.trim();
    let url: URL;
    try {
      url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    } catch (error) {
      throw new Error(
        `Configured network value '${permission.configurationPointer}' is invalid.`,
        { cause: error },
      );
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      !url.hostname
    ) {
      throw new Error(
        `Configured network value '${permission.configurationPointer}' must use HTTP(S) without credentials.`,
      );
    }
    const port = url.port
      ? Number.parseInt(url.port, 10)
      : url.protocol === "https:"
        ? 443
        : 80;
    if (!permission.allowedPorts.includes(port)) {
      throw new Error(
        `Configured network value '${permission.configurationPointer}' uses disallowed port ${port}.`,
      );
    }
    const host = url.hostname.includes(":")
      ? `[${url.hostname}]`
      : url.hostname;
    return `${host}:${port}`;
  });
  if (new Set(targets).size !== targets.length) {
    throw new Error("Configured network permissions resolve to duplicates.");
  }
  return targets;
}

function jsonPointer(value: JsonValue, pointer: string): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const rawSegment of pointer.split("/").slice(1)) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      current === null ||
      Array.isArray(current) ||
      typeof current !== "object"
    )
      return undefined;
    current = current[segment];
  }
  return current;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Extension policy ${label} must be a boolean.`);
  }
  return value;
}

function assertExactGrant(
  label: string,
  requested: readonly string[],
  granted: readonly string[],
): void {
  const requestedSet = new Set(requested);
  const grantedSet = new Set(granted);
  const missing = requested.filter((value) => !grantedSet.has(value));
  const unexpected = granted.filter((value) => !requestedSet.has(value));
  if (
    missing.length > 0 ||
    unexpected.length > 0 ||
    grantedSet.size !== granted.length
  ) {
    throw new Error(
      `Extension ${label} grant must exactly match the manifest request.`,
    );
  }
}

function assertAllowed(
  label: string,
  granted: readonly string[],
  allowed: readonly string[],
  extensionId: string,
): void {
  const allowedSet = new Set(allowed);
  const denied = granted.filter((value) => !allowedSet.has(value));
  if (denied.length > 0) {
    throw new Error(
      `Local policy denies ${label}${denied.length === 1 ? "" : "s"} ${denied.join(
        ", ",
      )} for '${extensionId}'.`,
    );
  }
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((nested) => typeof nested !== "string")
  ) {
    throw new Error(`Extension policy ${label} must be a string array.`);
  }
  const result = value.map((nested) => String(nested).trim());
  if (new Set(result).size !== result.length) {
    throw new Error(`Extension policy ${label} must not contain duplicates.`);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} contains unexpected or missing fields.`);
  }
}
