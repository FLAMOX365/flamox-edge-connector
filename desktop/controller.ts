import { isNotFound } from "../runtime/files.ts";
import { makeTempDirectory } from "../runtime/files.ts";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue } from "@edge-connector/sdk/extension";
import { loadConfig } from "../runtime/config.ts";
import { ConnectorIdentityStore } from "../runtime/connector-identity.ts";
import { ConnectorControlStateStore } from "../runtime/control-state.ts";
import {
  createExtensionBundle,
  extractExtensionBundle,
  parseExtensionBundle,
} from "../runtime/extension-bundle.ts";
import { computeExtensionDigest } from "../runtime/extension-integrity.ts";
import {
  InteractiveExtensionHostCapabilityProvider,
  NativeMessageBoxAdapter,
  type MessageBoxAdapter,
} from "../runtime/extension-host-capabilities.ts";
import { parseExtensionConfiguration } from "../runtime/extension-manager.ts";
import { parseExtensionGrant } from "../runtime/extension-policy.ts";
import { ExtensionStateStore } from "../runtime/extension-state.ts";
import {
  generatePublisherKey,
  signExtensionRelease,
} from "../runtime/extension-publisher.ts";
import { type ConnectorHost, startConnectorHost } from "../runtime/main.ts";
import type { RuntimeLogger } from "../runtime/logger.ts";
import type {
  DesktopLogEntry,
  DesktopManagedConnection,
  DesktopSettings,
  DesktopState,
  ExecuteActionInput,
  InstallBundleInput,
  PublisherKeyOutput,
} from "./contracts.ts";

export type DesktopOptions = {
  readonly messageBox?: MessageBoxAdapter;
  readonly onStateChanged?: () => void;
};

const maximumSettingsBytes = 2 * 1024 * 1024;
const maximumBundleBytes = 150 * 1024 * 1024;

/** Visual test host over the exact same runtime used by the service binary. */
export class DesktopConnectorController {
  #host?: ConnectorHost;
  #settings: DesktopSettings;
  #logs: DesktopLogEntry[] = [];
  #managedConnection: DesktopManagedConnection | null = null;
  #persistedExtensions: readonly unknown[] = [];

  private constructor(
    private readonly settingsPath: string,
    settings: DesktopSettings,
    private readonly options: DesktopOptions = {},
  ) {
    this.#settings = settings;
  }

  static async create(
    settingsPath = defaultSettingsPath(),
    options: DesktopOptions = {},
  ): Promise<DesktopConnectorController> {
    const controller = new DesktopConnectorController(
      settingsPath,
      await readSettings(settingsPath),
      options,
    );
    await controller.loadPersistentState();
    return controller;
  }

  state(): DesktopState {
    const status = this.#host?.status;
    const managedConnection = this.#host?.bundle.controlPlaneAgent?.state();
    if (managedConnection) this.#managedConnection = managedConnection;
    const extensions = this.#host?.bundle.extensionManager.list();
    if (extensions) this.#persistedExtensions = extensions;
    return {
      running: this.#host !== undefined,
      settings: this.#settings,
      status: status
        ? {
            connectionState: status.connectionState,
            lastConnectedAt: date(status.lastConnectedAt),
            lastInboundAt: date(status.lastInboundAt),
            reconnectAttempt: status.reconnectAttempt,
          }
        : null,
      managedConnection: this.#managedConnection,
      extensions: this.#persistedExtensions,
      logs: [...this.#logs],
    };
  }

  async saveSettings(value: unknown): Promise<DesktopState> {
    if (this.#host) {
      throw new Error("Stop the connector before changing runtime settings.");
    }
    this.#settings = parseSettings(value);
    await this.persistSettings();
    await this.loadPersistentState();
    this.log("info", "Desktop settings saved.");
    return this.state();
  }

  private async persistSettings(): Promise<void> {
    await fs.mkdir(dirname(this.settingsPath), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.settingsPath}.tmp-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(
        temporary,
        `${JSON.stringify(this.#settings, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      await fs.rename(temporary, this.settingsPath);
    } catch (error) {
      await fs.rm(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async loadPersistentState(): Promise<void> {
    const identity = await new ConnectorIdentityStore(
      join(this.#settings.dataDirectory, "identity", "connector.json"),
    ).load();
    const control = await new ConnectorControlStateStore(
      join(this.#settings.dataDirectory, "state", "control.json"),
    ).load();
    this.#managedConnection = identity
      ? {
          connectorId: identity.connectorId,
          tenantId: identity.tenantId,
          pairedAt: identity.pairedAt,
          lastSuccessfulSyncAt: null,
          desiredRevision: control.desiredRevision,
          commandSequence: control.commandSequence,
          lastErrorCode: null,
          lastErrorMessage: null,
        }
      : null;
    this.#persistedExtensions = await new ExtensionStateStore(
      join(this.#settings.dataDirectory, "state", "extensions.json"),
    ).load();
  }

  async start(): Promise<DesktopState> {
    if (this.#host) return this.state();
    await fs.mkdir(this.#settings.dataDirectory, {
      recursive: true,
      mode: 0o700,
    });
    await fs.mkdir(this.#settings.functionsDirectory, {
      recursive: true,
      mode: 0o700,
    });
    this.#host = await startConnectorHost(
      loadConfig(toEnvironment(this.#settings)),
      this.logger(),
      {
        onStateChanged: this.options.onStateChanged,
        hostCapabilities: new InteractiveExtensionHostCapabilityProvider(
          this.options.messageBox ?? new NativeMessageBoxAdapter(),
        ),
      },
    );
    if (
      this.#host.bundle.controlPlaneAgent &&
      this.#settings.pairingCode.length > 0
    ) {
      this.#settings = { ...this.#settings, pairingCode: "" };
      await this.persistSettings();
      this.log(
        "info",
        "One-time pairing code removed after successful pairing.",
      );
    }
    this.#host.finished.finally(() => {
      this.#host = undefined;
      this.log("info", "Connector runtime stopped.");
    });
    this.log("info", "Connector runtime started.");
    return this.state();
  }

  async connect(value: unknown): Promise<DesktopState> {
    await this.saveSettings(value);
    if (!this.#settings.managementUrl || !this.#settings.pairingCode) {
      throw new Error(
        "Management URL and one-time pairing code are required for the initial connection.",
      );
    }
    return await this.start();
  }

  async stop(): Promise<DesktopState> {
    const host = this.#host;
    if (!host) return this.state();
    host.stop();
    await host.finished;
    if (this.#host === host) this.#host = undefined;
    return this.state();
  }

  async installBundle(input: InstallBundleInput): Promise<DesktopState> {
    const host = this.requiredHost();
    if (
      !(input.bytes instanceof Uint8Array) ||
      input.bytes.byteLength > maximumBundleBytes
    ) {
      throw new Error("Extension bundle bytes are missing or too large.");
    }
    const bundle = parseExtensionBundle(
      JSON.parse(new TextDecoder().decode(input.bytes)),
    );
    const source = await makeTempDirectory("edge-desktop-bundle-");
    await fs.rmdir(source);
    try {
      await extractExtensionBundle(bundle, source);
      await host.bundle.extensionManager.install({
        sourceDirectory: source,
        release: bundle.release,
        grant: parseExtensionGrant(input.grant),
        configuration: parseExtensionConfiguration(input.configuration),
        activate: input.activate,
        managementMode: "LOCAL",
      });
    } finally {
      await fs.rm(source, { recursive: true }).catch(() => undefined);
    }
    this.log(
      "info",
      `Installed local extension '${bundle.release.extensionId}'.`,
    );
    return this.state();
  }

  async reconfigure(
    extensionId: string,
    configuration: unknown,
    grant?: unknown,
  ): Promise<DesktopState> {
    await this.requiredHost().bundle.extensionManager.reconfigure(extensionId, {
      configuration: parseExtensionConfiguration(configuration),
      grant: grant === undefined ? undefined : parseExtensionGrant(grant),
    });
    return this.state();
  }

  async activate(extensionId: string): Promise<DesktopState> {
    await this.requiredHost().bundle.extensionManager.activate(extensionId);
    return this.state();
  }

  async disable(extensionId: string): Promise<DesktopState> {
    await this.requiredHost().bundle.extensionManager.disable(extensionId);
    return this.state();
  }

  async rollback(extensionId: string, version?: string): Promise<DesktopState> {
    await this.requiredHost().bundle.extensionManager.rollback(
      extensionId,
      version,
    );
    return this.state();
  }

  async uninstall(extensionId: string): Promise<DesktopState> {
    await this.requiredHost().bundle.extensionManager.uninstall(extensionId);
    return this.state();
  }

  execute(input: ExecuteActionInput): Promise<JsonValue> {
    return this.requiredHost().bundle.extensionManager.execute(
      crypto.randomUUID(),
      input.extensionId,
      input.action,
      input.input,
    );
  }

  digest(sourceDirectory: string): Promise<string> {
    return computeExtensionDigest(sourceDirectory);
  }

  async generatePublisher(
    publisher: string,
    keyId: string,
  ): Promise<PublisherKeyOutput> {
    const pair = await generatePublisherKey(publisher, keyId);
    return {
      privateKey: jsonBytes(pair.privateKey),
      trust: jsonBytes(pair.trust),
    };
  }

  async sign(
    sourceDirectory: string,
    privateKey: Uint8Array,
    keyId: string,
  ): Promise<Uint8Array> {
    if (
      !(privateKey instanceof Uint8Array) ||
      privateKey.byteLength > maximumSettingsBytes
    ) {
      throw new Error("Publisher private key is missing or too large.");
    }
    const parsed = JSON.parse(new TextDecoder().decode(privateKey));
    return jsonBytes(
      await signExtensionRelease(sourceDirectory, parsed, keyId),
    );
  }

  async pack(sourceDirectory: string, release: unknown): Promise<Uint8Array> {
    const bundle = await createExtensionBundle(sourceDirectory, release);
    return new TextEncoder().encode(`${JSON.stringify(bundle)}\n`);
  }

  clearLogs(): DesktopState {
    this.#logs = [];
    return this.state();
  }

  private requiredHost(): ConnectorHost {
    if (!this.#host) throw new Error("Start the connector runtime first.");
    return this.#host;
  }

  private logger(): RuntimeLogger {
    return {
      error: (...values) => this.log("error", values),
      warn: (...values) => this.log("warn", values),
      info: (...values) => this.log("info", values),
      debug: (...values) => this.log("debug", values),
    };
  }

  private log(level: DesktopLogEntry["level"], value: unknown): void {
    const values = Array.isArray(value) ? value : [value];
    const message = values.map(safeText).join(" ").slice(0, 4_000);
    this.#logs.push({ at: new Date().toISOString(), level, message });
    if (this.#logs.length > 1_000) {
      this.#logs.splice(0, this.#logs.length - 1_000);
    }
    console[level](message);
    this.options.onStateChanged?.();
  }
}

export function defaultSettingsPath(): string {
  const base =
    process.env["APPDATA"] ??
    process.env["XDG_CONFIG_HOME"] ??
    (process.env["HOME"]
      ? join(process.env["HOME"]!, ".config")
      : process.cwd());
  return join(base, "flamox-edge-connector-desktop", "settings.json");
}

export function defaultSettings(): DesktopSettings {
  const base = dirname(defaultSettingsPath());
  return {
    bindHost: "127.0.0.1",
    bindPort: 8080,
    managementUrl: "",
    pairingCode: "",
    displayName: "Desktop Test Connector",
    dataDirectory: join(base, "data"),
    functionsDirectory: join(base, "functions"),
    websocketUrl: "",
    controlPlaneUrl: "",
    tokenEndpoint: "",
    clientId: "",
    clientSecret: "",
    allowInsecureConnections: false,
    trustedPublishersFile: "",
    extensionPolicyFile: "",
    logLevel: "debug",
  };
}

export function parseSettings(value: unknown): DesktopSettings {
  if (!record(value)) throw new Error("Desktop settings must be an object.");
  const defaults = defaultSettings();
  const result: DesktopSettings = {
    bindHost: text(value.bindHost, "bindHost", defaults.bindHost),
    bindPort: integer(value.bindPort, "bindPort", 1, 65_535),
    managementUrl: text(value.managementUrl, "managementUrl", "", true),
    pairingCode: text(value.pairingCode, "pairingCode", "", true),
    displayName: text(value.displayName, "displayName", defaults.displayName),
    dataDirectory: text(
      value.dataDirectory,
      "dataDirectory",
      defaults.dataDirectory,
    ),
    functionsDirectory: text(
      value.functionsDirectory,
      "functionsDirectory",
      defaults.functionsDirectory,
    ),
    websocketUrl: text(value.websocketUrl, "websocketUrl", "", true),
    controlPlaneUrl: text(value.controlPlaneUrl, "controlPlaneUrl", "", true),
    tokenEndpoint: text(value.tokenEndpoint, "tokenEndpoint", "", true),
    clientId: text(value.clientId, "clientId", "", true),
    clientSecret: text(value.clientSecret, "clientSecret", "", true),
    allowInsecureConnections: value.allowInsecureConnections === true,
    trustedPublishersFile: text(
      value.trustedPublishersFile,
      "trustedPublishersFile",
      "",
      true,
    ),
    extensionPolicyFile: text(
      value.extensionPolicyFile,
      "extensionPolicyFile",
      "",
      true,
    ),
    logLevel:
      value.logLevel === "error" ||
      value.logLevel === "warn" ||
      value.logLevel === "info" ||
      value.logLevel === "debug"
        ? value.logLevel
        : defaults.logLevel,
  };
  loadConfig(toEnvironment(result));
  return result;
}

async function readSettings(path: string): Promise<DesktopSettings> {
  try {
    const info = await fs.stat(path);
    if (!info.isFile() || info.size > maximumSettingsBytes) {
      throw new Error("Desktop settings file is too large.");
    }
    return parseSettings(JSON.parse(await fs.readFile(path, "utf8")));
  } catch (error) {
    if (isNotFound(error)) return defaultSettings();
    throw error;
  }
}

function toEnvironment(
  settings: DesktopSettings,
): Record<string, string | undefined> {
  return {
    EDGE_CONNECTOR_BIND_HOST: settings.bindHost,
    EDGE_CONNECTOR_BIND_PORT: String(settings.bindPort),
    EDGE_CONNECTOR_MANAGEMENT_URL: optional(settings.managementUrl),
    EDGE_CONNECTOR_PAIRING_CODE: optional(settings.pairingCode),
    EDGE_CONNECTOR_DISPLAY_NAME: settings.displayName,
    EDGE_CONNECTOR_DATA_DIRECTORY: settings.dataDirectory,
    EDGE_CONNECTOR_FUNCTIONS_DIR: settings.functionsDirectory,
    EDGE_CONNECTOR_WS_URL: optional(settings.websocketUrl),
    EDGE_CONNECTOR_CONTROL_PLANE_URL: optional(settings.controlPlaneUrl),
    EDGE_CONNECTOR_TOKEN_ENDPOINT: optional(settings.tokenEndpoint),
    EDGE_CONNECTOR_CLIENT_ID: optional(settings.clientId),
    EDGE_CONNECTOR_CLIENT_SECRET: optional(settings.clientSecret),
    EDGE_CONNECTOR_ALLOW_INSECURE_CONNECTIONS: String(
      settings.allowInsecureConnections,
    ),
    EDGE_CONNECTOR_TRUSTED_PUBLISHERS_FILE: optional(
      settings.trustedPublishersFile,
    ),
    EDGE_CONNECTOR_EXTENSION_POLICY_FILE: optional(
      settings.extensionPolicyFile,
    ),
    EDGE_CONNECTOR_LOG_LEVEL: settings.logLevel,
  };
}

function optional(value: string): string | undefined {
  return value.trim() ? value.trim() : undefined;
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(
  value: unknown,
  name: string,
  fallback: string,
  empty = false,
): string {
  if (value === undefined) return fallback;
  if (
    typeof value !== "string" ||
    value.length > 16_384 ||
    (!empty && !value.trim())
  ) {
    throw new Error(`Desktop setting '${name}' is invalid.`);
  }
  return value.trim();
}

function integer(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new Error(`Desktop setting '${name}' is invalid.`);
  }
  return Number(value);
}

function date(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function safeText(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
