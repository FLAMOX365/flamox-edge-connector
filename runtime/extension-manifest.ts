import * as fs from "node:fs/promises";
export const EXTENSION_MANIFEST_FILE = "extension-manifest.json";
export const EXTENSION_MANIFEST_SCHEMA_VERSION = 2;

export type ExtensionActionManifest = {
  readonly name: string;
  readonly description?: string;
  readonly idempotent: boolean;
  readonly timeoutSeconds: number;
  readonly inputSchema?: string;
  readonly outputSchema?: string;
};

export type ExtensionContributionManifest = {
  readonly id: string;
  readonly area: "telephony";
  readonly contract: "telephony.provider";
  readonly contractVersion: 1;
  readonly operations: {
    readonly startCall: string;
    readonly endCall: string;
    readonly synchronizeCalls: string;
    readonly health: string;
  };
};

export type ExtensionConfiguredNetworkPermission = {
  readonly configurationPointer: string;
  readonly allowedPorts: readonly number[];
};

export type ExtensionLifecycleManifest = {
  readonly install?: string;
  readonly configure?: string;
  readonly activate?: string;
  readonly deactivate?: string;
  readonly migrate?: string;
  readonly uninstall?: string;
};

export type ExtensionManifest = {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly publisher: string;
  readonly version: string;
  readonly runtime: {
    readonly kind: "node-process";
    readonly entrypoint: string;
  };
  readonly capabilities: readonly string[];
  readonly permissions: {
    readonly network: readonly string[];
    readonly configuredNetwork: readonly ExtensionConfiguredNetworkPermission[];
    readonly secrets: readonly string[];
  };
  readonly actions: readonly ExtensionActionManifest[];
  readonly contributions: readonly ExtensionContributionManifest[];
  readonly configurationSchema?: string;
  readonly configurationUiSchema?: string;
  readonly translations: Readonly<Record<string, string>>;
  readonly notices?: string;
  readonly lifecycle?: ExtensionLifecycleManifest;
  readonly health?: {
    readonly action: string;
    readonly timeoutSeconds: number;
  };
};

const identifierPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const secretPattern = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;
const semanticVersionPattern =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const networkTargetPattern = /^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/iu;

/** Parses and strictly validates one extension manifest. */
export function parseExtensionManifest(value: unknown): ExtensionManifest {
  const root = record(value, "Extension manifest");
  exactKeys(
    root,
    [
      "schemaVersion",
      "id",
      "displayName",
      "description",
      "publisher",
      "version",
      "runtime",
      "capabilities",
      "permissions",
      "actions",
    ],
    [
      "$schema",
      "contributions",
      "configurationSchema",
      "configurationUiSchema",
      "translations",
      "notices",
      "lifecycle",
      "health",
    ],
    "Extension manifest",
  );

  if (root.schemaVersion !== EXTENSION_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported extension manifest schema version '${String(
        root.schemaVersion,
      )}'.`,
    );
  }

  const id = identifier(root.id, "Extension id");
  const version = text(root.version, "Extension version", 1, 100);
  if (!semanticVersionPattern.test(version)) {
    throw new Error("Extension version must be a semantic version.");
  }

  const runtime = parseRuntime(root.runtime);
  const permissions = parsePermissions(root.permissions);
  const capabilities = uniqueIdentifiers(
    root.capabilities,
    "Extension capabilities",
  );
  const actions = parseActions(root.actions);
  const contributions =
    root.contributions === undefined
      ? []
      : parseContributions(root.contributions, actions, capabilities);
  const actionNames = new Set(actions.map((action) => action.name));
  const health =
    root.health === undefined
      ? undefined
      : parseHealth(root.health, actionNames);
  const configurationSchema =
    root.configurationSchema === undefined
      ? undefined
      : safeRelativePath(root.configurationSchema, "Configuration schema", [
          ".json",
        ]);
  const configurationUiSchema =
    root.configurationUiSchema === undefined
      ? undefined
      : safeRelativePath(
          root.configurationUiSchema,
          "Configuration UI schema",
          [".json"],
        );
  const translations =
    root.translations === undefined ? {} : parseTranslations(root.translations);
  const notices =
    root.notices === undefined
      ? undefined
      : safeRelativePath(root.notices, "Third-party notices", [".txt", ".md"]);
  const lifecycle =
    root.lifecycle === undefined
      ? undefined
      : parseLifecycle(root.lifecycle, actionNames);

  return {
    schemaVersion: EXTENSION_MANIFEST_SCHEMA_VERSION,
    id,
    displayName: text(root.displayName, "Extension display name", 1, 120),
    description: text(root.description, "Extension description", 1, 2_000),
    publisher: text(root.publisher, "Extension publisher", 1, 200),
    version,
    runtime,
    capabilities,
    permissions,
    actions,
    contributions,
    configurationSchema,
    configurationUiSchema,
    translations,
    notices,
    lifecycle,
    health,
  };
}

/** Reads and validates a manifest from an extension package directory. */
export async function readExtensionManifest(
  extensionDirectory: string,
): Promise<ExtensionManifest> {
  const path = `${extensionDirectory}/${EXTENSION_MANIFEST_FILE}`;
  let parsed: unknown;
  try {
    const info = await fs.stat(path);
    if (!info.isFile() || info.size > 256 * 1024) {
      throw new Error("Extension manifest is missing or too large.");
    }
    parsed = JSON.parse(await fs.readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read extension manifest '${path}'.`, {
      cause: error,
    });
  }
  return parseExtensionManifest(parsed);
}

function parseRuntime(value: unknown): ExtensionManifest["runtime"] {
  const runtime = record(value, "Extension runtime");
  exactKeys(runtime, ["kind", "entrypoint"], [], "Extension runtime");
  if (runtime.kind !== "node-process") {
    throw new Error("Extension runtime kind must be 'node-process'.");
  }
  return {
    kind: "node-process",
    entrypoint: safeRelativePath(runtime.entrypoint, "Extension entrypoint", [
      ".js",
      ".mjs",
      ".ts",
      ".mts",
    ]),
  };
}

function parsePermissions(value: unknown): ExtensionManifest["permissions"] {
  const permissions = record(value, "Extension permissions");
  exactKeys(
    permissions,
    ["network", "secrets"],
    ["configuredNetwork"],
    "Extension permissions",
  );
  const network = uniqueStrings(permissions.network, "Network permissions");
  for (const target of network) {
    if (!networkTargetPattern.test(target)) {
      throw new Error(
        `Network permission '${target}' must be an exact host with an optional port.`,
      );
    }
    const port = target.match(/:(\d+)$/u)?.[1];
    if (port !== undefined && Number(port) > 65_535) {
      throw new Error(
        `Network permission '${target}' contains an invalid port.`,
      );
    }
  }

  const secrets = uniqueStrings(permissions.secrets, "Secret permissions");
  for (const secret of secrets) {
    if (!secretPattern.test(secret)) {
      throw new Error(
        `Secret permission '${secret}' must use upper snake case.`,
      );
    }
  }
  const configuredNetwork =
    permissions.configuredNetwork === undefined
      ? []
      : parseConfiguredNetwork(permissions.configuredNetwork);
  return { network, configuredNetwork, secrets };
}

function parseConfiguredNetwork(
  value: unknown,
): readonly ExtensionConfiguredNetworkPermission[] {
  if (!Array.isArray(value)) {
    throw new Error("Configured network permissions must be an array.");
  }
  const pointers = new Set<string>();
  return value.map((nested, index) => {
    const permission = record(nested, `Configured network permission ${index}`);
    exactKeys(
      permission,
      ["configurationPointer", "allowedPorts"],
      [],
      `Configured network permission ${index}`,
    );
    const configurationPointer = text(
      permission.configurationPointer,
      `Configured network permission ${index} pointer`,
      1,
      300,
    );
    if (
      !configurationPointer.startsWith("/") ||
      configurationPointer
        .split("/")
        .slice(1)
        .some(
          (segment) =>
            segment.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(segment),
        )
    ) {
      throw new Error("Configured network permission pointer is invalid.");
    }
    if (pointers.has(configurationPointer)) {
      throw new Error("Configured network permission pointers must be unique.");
    }
    pointers.add(configurationPointer);
    if (
      !Array.isArray(permission.allowedPorts) ||
      permission.allowedPorts.length === 0 ||
      permission.allowedPorts.some(
        (port) =>
          !Number.isInteger(port) || Number(port) < 1 || Number(port) > 65_535,
      )
    ) {
      throw new Error("Configured network permission ports are invalid.");
    }
    const allowedPorts = permission.allowedPorts.map(Number);
    if (new Set(allowedPorts).size !== allowedPorts.length) {
      throw new Error("Configured network permission ports must be unique.");
    }
    return { configurationPointer, allowedPorts };
  });
}

function parseLifecycle(
  value: unknown,
  actionNames: ReadonlySet<string>,
): ExtensionLifecycleManifest {
  const lifecycle = record(value, "Extension lifecycle");
  const names = [
    "install",
    "configure",
    "activate",
    "deactivate",
    "migrate",
    "uninstall",
  ] as const;
  exactKeys(lifecycle, [], names, "Extension lifecycle");
  const result: Record<string, string> = {};
  for (const name of names) {
    if (lifecycle[name] === undefined) continue;
    const action = identifier(lifecycle[name], `Extension lifecycle ${name}`);
    if (!actionNames.has(action)) {
      throw new Error(
        `Extension lifecycle action '${action}' is not declared.`,
      );
    }
    result[name] = action;
  }
  return result;
}

function parseTranslations(value: unknown): Readonly<Record<string, string>> {
  const translations = record(value, "Extension translations");
  const result: Record<string, string> = {};
  for (const [locale, path] of Object.entries(translations)) {
    if (!/^[a-z]{2}(?:-[A-Z]{2})?$/u.test(locale)) {
      throw new Error(`Extension translation locale '${locale}' is invalid.`);
    }
    result[locale] = safeRelativePath(
      path,
      `Extension translation '${locale}'`,
      [".json"],
    );
  }
  return result;
}

function parseActions(value: unknown): readonly ExtensionActionManifest[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Extension actions must contain at least one action.");
  }
  const names = new Set<string>();
  return value.map((nested, index) => {
    const action = record(nested, `Extension action ${index}`);
    exactKeys(
      action,
      ["name", "idempotent", "timeoutSeconds"],
      ["description", "inputSchema", "outputSchema"],
      `Extension action ${index}`,
    );
    const name = identifier(action.name, `Extension action ${index} name`);
    if (names.has(name)) {
      throw new Error(`Extension action '${name}' is declared more than once.`);
    }
    names.add(name);
    return {
      name,
      description:
        action.description === undefined
          ? undefined
          : text(
              action.description,
              `Extension action '${name}' description`,
              1,
              500,
            ),
      idempotent: boolean(
        action.idempotent,
        `Extension action '${name}' idempotent`,
      ),
      timeoutSeconds: boundedInteger(
        action.timeoutSeconds,
        `Extension action '${name}' timeoutSeconds`,
        1,
        120,
      ),
      inputSchema:
        action.inputSchema === undefined
          ? undefined
          : safeRelativePath(
              action.inputSchema,
              `Extension action '${name}' input schema`,
              [".json"],
            ),
      outputSchema:
        action.outputSchema === undefined
          ? undefined
          : safeRelativePath(
              action.outputSchema,
              `Extension action '${name}' output schema`,
              [".json"],
            ),
    };
  });
}

function parseContributions(
  value: unknown,
  actions: readonly ExtensionActionManifest[],
  capabilities: readonly string[],
): readonly ExtensionContributionManifest[] {
  if (!Array.isArray(value)) {
    throw new Error("Extension contributions must be an array.");
  }
  const actionMap = new Map(actions.map((action) => [action.name, action]));
  const identifiers = new Set<string>();
  return value.map((nested, index) => {
    const contribution = record(nested, `Extension contribution ${index}`);
    exactKeys(
      contribution,
      ["id", "area", "contract", "contractVersion", "operations"],
      [],
      `Extension contribution ${index}`,
    );
    const id = identifier(
      contribution.id,
      `Extension contribution ${index} id`,
    );
    if (identifiers.has(id)) {
      throw new Error(
        `Extension contribution '${id}' is declared more than once.`,
      );
    }
    identifiers.add(id);
    if (
      contribution.area !== "telephony" ||
      contribution.contract !== "telephony.provider" ||
      contribution.contractVersion !== 1
    ) {
      throw new Error(
        `Extension contribution '${id}' uses an unsupported area contract.`,
      );
    }
    const requiredCapabilities = [
      "telephony.provider.health.read",
      "telephony.call.start",
      "telephony.call.end",
      "telephony.call-history.read",
    ];
    const missingCapabilities = requiredCapabilities.filter(
      (capability) => !capabilities.includes(capability),
    );
    if (missingCapabilities.length > 0) {
      throw new Error(
        `Extension contribution '${id}' is missing required capabilities: ${missingCapabilities.join(
          ", ",
        )}.`,
      );
    }
    const operations = record(
      contribution.operations,
      `Extension contribution '${id}' operations`,
    );
    const operationNames = [
      "startCall",
      "endCall",
      "synchronizeCalls",
      "health",
    ] as const;
    exactKeys(
      operations,
      operationNames,
      [],
      `Extension contribution '${id}' operations`,
    );
    const mapped = Object.fromEntries(
      operationNames.map((operation) => {
        const actionName = identifier(
          operations[operation],
          `Extension contribution '${id}' operation '${operation}'`,
        );
        const action = actionMap.get(actionName);
        if (!action) {
          throw new Error(
            `Extension contribution '${id}' maps '${operation}' to undeclared action '${actionName}'.`,
          );
        }
        const mustBeIdempotent = operation !== "startCall";
        if (action.idempotent !== mustBeIdempotent) {
          throw new Error(
            `Extension contribution '${id}' operation '${operation}' has an invalid idempotency declaration.`,
          );
        }
        if (action.inputSchema || action.outputSchema) {
          throw new Error(
            `Extension contribution '${id}' operation '${operation}' cannot override its canonical schemas.`,
          );
        }
        return [operation, actionName];
      }),
    ) as ExtensionContributionManifest["operations"];
    return {
      id,
      area: "telephony",
      contract: "telephony.provider",
      contractVersion: 1,
      operations: mapped,
    };
  });
}

function parseHealth(
  value: unknown,
  actionNames: ReadonlySet<string>,
): NonNullable<ExtensionManifest["health"]> {
  const health = record(value, "Extension health");
  exactKeys(health, ["action", "timeoutSeconds"], [], "Extension health");
  const action = identifier(health.action, "Extension health action");
  if (!actionNames.has(action)) {
    throw new Error(`Extension health action '${action}' is not declared.`);
  }
  return {
    action,
    timeoutSeconds: boundedInteger(
      health.timeoutSeconds,
      "Extension health timeoutSeconds",
      1,
      60,
    ),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const actual = new Set(Object.keys(value));
  for (const key of required) {
    if (!actual.has(key)) {
      throw new Error(`${label} is missing required field '${key}'.`);
    }
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of actual) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unsupported field '${key}'.`);
    }
  }
}

function text(
  value: unknown,
  label: string,
  minimumLength: number,
  maximumLength: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length < minimumLength || normalized.length > maximumLength) {
    throw new Error(
      `${label} must contain between ${minimumLength} and ${maximumLength} characters.`,
    );
  }
  return normalized;
}

function identifier(value: unknown, label: string): string {
  const normalized = text(value, label, 1, 120);
  if (!identifierPattern.test(normalized)) {
    throw new Error(`${label} must be a lowercase dotted identifier.`);
  }
  return normalized;
}

function uniqueIdentifiers(value: unknown, label: string): readonly string[] {
  return uniqueStrings(value, label).map((nested, index) =>
    identifier(nested, `${label} ${index}`),
  );
}

function uniqueStrings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  const result = value.map((nested, index) =>
    text(nested, `${label} ${index}`, 1, 300),
  );
  if (new Set(result).size !== result.length) {
    throw new Error(`${label} must not contain duplicates.`);
  }
  return result;
}

function safeRelativePath(
  value: unknown,
  label: string,
  extensions: readonly string[],
): string {
  const path = text(value, label, 1, 300).replaceAll("\\", "/");
  if (
    path.startsWith("/") ||
    path.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw new Error(`${label} must be a safe relative path.`);
  }
  if (!extensions.some((extension) => path.endsWith(extension))) {
    throw new Error(`${label} must use one of: ${extensions.join(", ")}.`);
  }
  return path;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new Error(
      `${label} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return Number(value);
}
