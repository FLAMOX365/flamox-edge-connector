import type { ConnectorConfig } from "./config.ts";
import {
  type ConnectorIdentity,
  ConnectorIdentityStore,
  generateConnectorKeyPair,
} from "./connector-identity.ts";
import {
  type CommandResultPayload,
  ControlPlaneClient,
} from "./control-plane-client.ts";
import { ConnectorControlStateStore } from "./control-state.ts";
import type { ExtensionManager } from "./extension-manager.ts";
import type { ManagedExtensionReleaseVerifier } from "./extension-integrity.ts";
import type { ManagedExtensionPolicy } from "./extension-policy.ts";
import type { ManagedExtensionSecretProvider } from "./extension-secrets.ts";
import { ExtensionReconciler } from "./extension-reconciler.ts";
import { ConnectorAuditLog } from "./audit-log.ts";
import type { RuntimeLogger } from "./logger.ts";
import { createLogger } from "./logger.ts";
import { RuntimeError } from "./runtime-error.ts";
import { delay } from "./websocket-client.ts";

export type ControlPlaneAgentDependencies = {
  readonly onStateChanged?: () => void;
  readonly manager: ExtensionManager;
  readonly verifier: ManagedExtensionReleaseVerifier;
  readonly policy: ManagedExtensionPolicy;
  readonly secrets: ManagedExtensionSecretProvider;
};

export class ControlPlaneAgent {
  #lastSuccessfulSyncAt: string | null = null;
  #desiredRevision = 0;
  #commandSequence = 0;
  #lastErrorCode: string | null = null;
  #lastErrorMessage: string | null = null;

  constructor(
    readonly identity: ConnectorIdentity,
    private readonly client: ControlPlaneClient,
    private readonly reconciler: ExtensionReconciler,
    private readonly manager: ExtensionManager,
    private readonly stateStore: ConnectorControlStateStore,
    private readonly audit: ConnectorAuditLog,
    private readonly pollIntervalMs: number,
    private readonly logger: RuntimeLogger,
    private readonly onStateChanged: () => void = () => undefined,
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runOnce();
      } catch (error) {
        this.#lastErrorCode =
          error instanceof RuntimeError
            ? error.code
            : "CONTROL_PLANE_SYNC_FAILED";
        this.#lastErrorMessage =
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Control-plane synchronization failed.";
        this.logger.error(
          "Managed control-plane synchronization failed",
          error,
        );
      }
      this.onStateChanged();
      await delay(this.pollIntervalMs, signal);
    }
  }

  async runOnce(): Promise<void> {
    let state = await this.stateStore.load();
    const desired = await this.client.getDesiredState(state.desiredRevision);
    const reconciled = await this.reconciler.reconcile(desired);
    await this.client.reportObservedState({
      schemaVersion: 1,
      desiredRevision: desired.revision,
      observedAt: new Date().toISOString(),
      extensions: reconciled.observations,
    });
    if (reconciled.complete) {
      state = { ...state, desiredRevision: desired.revision };
      await this.stateStore.save(state);
    }

    const batch = await this.client.getCommands(state.commandSequence);
    for (const command of batch.commands) {
      const result = await this.executeCommand(command);
      await this.client.reportCommandResult(result);
      state = { ...state, commandSequence: command.sequence };
      await this.stateStore.save(state);
    }
    const events = this.audit.list().slice(0, 100);
    if (events.length > 0) {
      await this.client.reportAudit({ schemaVersion: 1, events });
      await this.audit.acknowledge(events.map((event) => event.eventId));
    }
    this.#desiredRevision = state.desiredRevision;
    this.#commandSequence = state.commandSequence;
    this.#lastSuccessfulSyncAt = new Date().toISOString();
    this.#lastErrorCode = null;
    this.#lastErrorMessage = null;
    this.onStateChanged();
  }

  state() {
    return {
      connectorId: this.identity.connectorId,
      tenantId: this.identity.tenantId,
      pairedAt: this.identity.pairedAt,
      lastSuccessfulSyncAt: this.#lastSuccessfulSyncAt,
      desiredRevision: this.#desiredRevision,
      commandSequence: this.#commandSequence,
      lastErrorCode: this.#lastErrorCode,
      lastErrorMessage: this.#lastErrorMessage,
    };
  }

  private async executeCommand(command: {
    readonly sequence: number;
    readonly commandId: string;
    readonly extensionId: string;
    readonly action: string;
    readonly input: Parameters<ExtensionManager["execute"]>[3];
    readonly expiresAt: string;
  }): Promise<CommandResultPayload> {
    if (Date.parse(command.expiresAt) <= Date.now()) {
      await this.audit.record(
        "extension.command",
        "FAILED",
        { commandId: command.commandId, reason: "expired" },
        command.extensionId,
      );
      return {
        schemaVersion: 1,
        sequence: command.sequence,
        commandId: command.commandId,
        status: "EXPIRED",
        errorCode: "COMMAND_EXPIRED",
        errorMessage: "The command expired before execution.",
      };
    }
    try {
      const output = await this.manager.execute(
        command.commandId,
        command.extensionId,
        command.action,
        command.input,
      );
      await this.audit.record(
        "extension.command",
        "SUCCEEDED",
        { commandId: command.commandId, action: command.action },
        command.extensionId,
      );
      return {
        schemaVersion: 1,
        sequence: command.sequence,
        commandId: command.commandId,
        status: "SUCCEEDED",
        output,
      };
    } catch (error) {
      const errorCode =
        error instanceof RuntimeError ? error.code : "EXTENSION_COMMAND_FAILED";
      await this.audit.record(
        "extension.command",
        "FAILED",
        { commandId: command.commandId, action: command.action, errorCode },
        command.extensionId,
      );
      return {
        schemaVersion: 1,
        sequence: command.sequence,
        commandId: command.commandId,
        status: "FAILED",
        errorCode,
        errorMessage:
          error instanceof RuntimeError
            ? error.message
            : "Extension command execution failed.",
      };
    }
  }
}

export async function createControlPlaneAgent(
  config: ConnectorConfig,
  dependencies: ControlPlaneAgentDependencies,
  logger: RuntimeLogger = createLogger(config.logLevel),
): Promise<ControlPlaneAgent | undefined> {
  if (!config.managementUrl) return undefined;
  const identityStore = new ConnectorIdentityStore(
    `${config.dataDirectory}/identity/connector.json`,
  );
  let identity = await identityStore.load();
  if (!identity) {
    if (!config.pairingCode) {
      throw new Error(
        "Connector is not paired; EDGE_CONNECTOR_PAIRING_CODE is required once.",
      );
    }
    const keys = await generateConnectorKeyPair();
    const pairingClient = new ControlPlaneClient(config.managementUrl);
    const result = await pairingClient.pair(
      config.pairingCode,
      config.connectorDisplayName,
      keys,
    );
    identity = {
      schemaVersion: 1,
      connectorId: result.connectorId,
      tenantId: result.tenantId,
      credentialSecret: result.credentialSecret,
      ...keys,
      pairedAt: new Date().toISOString(),
    };
    await identityStore.save(identity);
  }
  return await createPairedAgent(config, dependencies, identity, logger);
}

async function createPairedAgent(
  config: ConnectorConfig,
  dependencies: ControlPlaneAgentDependencies,
  identity: ConnectorIdentity,
  logger: RuntimeLogger,
): Promise<ControlPlaneAgent> {
  const client = new ControlPlaneClient(config.managementUrl!, identity);
  const audit = new ConnectorAuditLog(
    `${config.dataDirectory}/state/audit-outbox.json`,
  );
  await audit.initialize();
  const reconciler = new ExtensionReconciler(
    dependencies.manager,
    dependencies.verifier,
    dependencies.policy,
    dependencies.secrets,
    identity,
    client,
    audit,
  );
  return new ControlPlaneAgent(
    identity,
    client,
    reconciler,
    dependencies.manager,
    new ConnectorControlStateStore(
      `${config.dataDirectory}/state/control.json`,
    ),
    audit,
    config.managementPollIntervalMs,
    logger,
    dependencies.onStateChanged,
  );
}
