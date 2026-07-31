import type { JsonValue } from "../sdk/extension.ts";
import type { PathPickerRequest } from "./path-picker.ts";
export type { JsonValue } from "../sdk/extension.ts";
export type { PathPickerRequest } from "./path-picker.ts";

export type DesktopSettings = {
  readonly bindHost: string;
  readonly bindPort: number;
  readonly managementUrl: string;
  readonly pairingCode: string;
  readonly displayName: string;
  readonly dataDirectory: string;
  readonly functionsDirectory: string;
  readonly websocketUrl: string;
  readonly controlPlaneUrl: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly allowInsecureConnections: boolean;
  readonly trustedPublishersFile: string;
  readonly extensionPolicyFile: string;
  readonly logLevel: "error" | "warn" | "info" | "debug";
};

export type DesktopLogEntry = {
  readonly at: string;
  readonly level: "error" | "warn" | "info" | "debug";
  readonly message: string;
};

export type DesktopManagedConnection = {
  readonly connectorId: string;
  readonly tenantId: string;
  readonly pairedAt: string;
  readonly lastSuccessfulSyncAt: string | null;
  readonly desiredRevision: number;
  readonly commandSequence: number;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
};

export type DesktopState = {
  readonly running: boolean;
  readonly settings: DesktopSettings;
  readonly status: {
    readonly connectionState: string;
    readonly lastConnectedAt: string | null;
    readonly lastInboundAt: string | null;
    readonly reconnectAttempt: number;
  } | null;
  readonly managedConnection: DesktopManagedConnection | null;
  readonly extensions: readonly unknown[];
  readonly logs: readonly DesktopLogEntry[];
};

export type InstallBundleInput = {
  readonly bytes: Uint8Array;
  readonly grant: unknown;
  readonly configuration: unknown;
  readonly activate: boolean;
};

export type ExecuteActionInput = {
  readonly extensionId: string;
  readonly action: string;
  readonly input: JsonValue;
};

export type PublisherKeyOutput = {
  readonly privateKey: Uint8Array;
  readonly trust: Uint8Array;
};

export interface DesktopBindings {
  getState(): Promise<DesktopState>;
  choosePath(request: PathPickerRequest): Promise<string | null>;
  saveSettings(settings: DesktopSettings): Promise<DesktopState>;
  connectManaged(settings: DesktopSettings): Promise<DesktopState>;
  startConnector(): Promise<DesktopState>;
  stopConnector(): Promise<DesktopState>;
  installBundle(input: InstallBundleInput): Promise<DesktopState>;
  reconfigureExtension(
    extensionId: string,
    configuration: unknown,
    grant?: unknown,
  ): Promise<DesktopState>;
  activateExtension(extensionId: string): Promise<DesktopState>;
  disableExtension(extensionId: string): Promise<DesktopState>;
  rollbackExtension(
    extensionId: string,
    version?: string,
  ): Promise<DesktopState>;
  uninstallExtension(extensionId: string): Promise<DesktopState>;
  executeAction(input: ExecuteActionInput): Promise<JsonValue>;
  digestExtension(sourceDirectory: string): Promise<string>;
  generatePublisherKey(
    publisher: string,
    keyId: string,
  ): Promise<PublisherKeyOutput>;
  signExtension(
    sourceDirectory: string,
    privateKey: Uint8Array,
    keyId: string,
  ): Promise<Uint8Array>;
  packExtension(sourceDirectory: string, release: unknown): Promise<Uint8Array>;
  clearLogs(): Promise<DesktopState>;
}

declare global {
  const bindings: DesktopBindings;
}
