import { makeTempDirectory } from "./files.ts";
import * as fs from "node:fs/promises";
import type { ConnectorAuditLog } from "./audit-log.ts";
import type { ConnectorIdentity } from "./connector-identity.ts";
import { decryptConnectorSecret } from "./connector-identity.ts";
import type { ControlPlaneClient } from "./control-plane-client.ts";
import type {
  ConnectorDesiredState,
  DesiredExtension,
} from "./control-plane-contract.ts";
import { extractExtensionBundle } from "./extension-bundle.ts";
import type { ManagedExtensionReleaseVerifier } from "./extension-integrity.ts";
import type { ExtensionManager } from "./extension-manager.ts";
import type { ManagedExtensionPolicy } from "./extension-policy.ts";
import type { ManagedExtensionSecretProvider } from "./extension-secrets.ts";
import { RuntimeError } from "./runtime-error.ts";

export type ExtensionObservation = {
  readonly extensionId: string;
  readonly desiredStatus: string;
  readonly desiredVersion: string | null;
  readonly observedStatus: string;
  readonly observedVersion: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
};

export type ReconciliationResult = {
  readonly complete: boolean;
  readonly observations: readonly ExtensionObservation[];
};

export class ExtensionReconciler {
  constructor(
    private readonly manager: ExtensionManager,
    private readonly verifier: ManagedExtensionReleaseVerifier,
    private readonly policy: ManagedExtensionPolicy,
    private readonly secrets: ManagedExtensionSecretProvider,
    private readonly identity: ConnectorIdentity,
    private readonly client: ControlPlaneClient,
    private readonly audit: ConnectorAuditLog,
  ) {}

  async reconcile(
    desired: ConnectorDesiredState,
  ): Promise<ReconciliationResult> {
    this.verifier.updateManagedPublishers(desired.publisherTrust);
    this.policy.updateManagedRules(desired.extensionPolicy);
    const observations: ExtensionObservation[] = [];
    let complete = true;
    const desiredIds = new Set(
      desired.extensions.map((extension) => extension.extensionId),
    );

    for (const extension of desired.extensions) {
      try {
        await this.reconcileExtension(extension);
        const observed = this.manager
          .list()
          .find((state) => state.extensionId === extension.extensionId);
        observations.push(observation(extension, observed));
      } catch (error) {
        complete = false;
        const code =
          error instanceof RuntimeError
            ? error.code
            : "EXTENSION_RECONCILIATION_FAILED";
        await this.audit.record(
          "extension.reconcile",
          "FAILED",
          { errorCode: code },
          extension.extensionId,
        );
        const observed = this.manager
          .list()
          .find((state) => state.extensionId === extension.extensionId);
        observations.push({
          ...observation(extension, observed),
          errorCode: code,
          errorMessage: safeErrorMessage(error),
        });
      }
    }

    for (const installed of this.manager.list()) {
      if (
        installed.managementMode !== "MANAGED" ||
        desiredIds.has(installed.extensionId)
      )
        continue;
      try {
        await this.manager.uninstall(installed.extensionId);
        this.secrets.remove(installed.extensionId);
        await this.audit.record(
          "extension.uninstall",
          "SUCCEEDED",
          { reason: "removed-from-desired-state" },
          installed.extensionId,
        );
      } catch (error) {
        complete = false;
        observations.push({
          extensionId: installed.extensionId,
          desiredStatus: "ABSENT",
          desiredVersion: null,
          observedStatus: installed.status,
          observedVersion: installed.version,
          errorCode:
            error instanceof RuntimeError
              ? error.code
              : "EXTENSION_UNINSTALL_FAILED",
          errorMessage: safeErrorMessage(error),
        });
      }
    }
    return { complete, observations };
  }

  private async reconcileExtension(extension: DesiredExtension): Promise<void> {
    const installed = this.manager
      .list()
      .find((state) => state.extensionId === extension.extensionId);
    if (extension.status === "ABSENT") {
      if (installed?.managementMode === "LOCAL") {
        throw new RuntimeError(
          "LOCAL_EXTENSION_OWNERSHIP_CONFLICT",
          "A locally managed extension cannot be removed by Desired State.",
        );
      }
      if (installed) await this.manager.uninstall(extension.extensionId);
      this.secrets.remove(extension.extensionId);
      return;
    }
    if (installed?.managementMode === "LOCAL") {
      throw new RuntimeError(
        "LOCAL_EXTENSION_OWNERSHIP_CONFLICT",
        "A locally managed extension cannot be replaced by Desired State.",
      );
    }
    const decryptedSecrets: Record<string, string> = {};
    for (const [name, envelope] of Object.entries(extension.secrets)) {
      decryptedSecrets[name] = await decryptConnectorSecret(
        this.identity,
        envelope,
      );
    }
    this.secrets.update(extension.extensionId, decryptedSecrets);

    if (!installed || installed.version !== extension.version) {
      const bundle = await this.client.downloadBundle(extension.bundleUrl!);
      if (
        bundle.release.extensionId !== extension.extensionId ||
        bundle.release.version !== extension.version
      ) {
        throw new Error("Downloaded bundle does not match Desired State.");
      }
      const source = await makeTempDirectory("edge-reconcile-");
      await fs.rmdir(source);
      try {
        await extractExtensionBundle(bundle, source);
        await this.manager.install({
          sourceDirectory: source,
          release: bundle.release,
          grant: extension.grant!,
          configuration: extension.configuration!,
          activate: extension.status === "ACTIVE",
          managementMode: "MANAGED",
        });
      } finally {
        await fs.rm(source, { recursive: true }).catch(() => undefined);
      }
      await this.audit.record(
        installed ? "extension.update" : "extension.install",
        "SUCCEEDED",
        { version: extension.version! },
        extension.extensionId,
      );
      return;
    }

    if (
      canonical(installed.configuration) !==
        canonical(extension.configuration) ||
      canonical(installed.grant) !== canonical(extension.grant)
    ) {
      await this.manager.reconfigure(extension.extensionId, {
        configuration: extension.configuration!,
        grant: extension.grant!,
      });
      await this.audit.record(
        "extension.reconfigure",
        "SUCCEEDED",
        {},
        extension.extensionId,
      );
    }
    const current = this.manager
      .list()
      .find((state) => state.extensionId === extension.extensionId)!;
    if (extension.status === "ACTIVE" && current.status !== "ACTIVE") {
      await this.manager.activate(extension.extensionId);
    } else if (extension.status === "DISABLED" && current.status === "ACTIVE") {
      await this.manager.disable(extension.extensionId);
    }
  }
}

function observation(
  desired: DesiredExtension,
  observed: ReturnType<ExtensionManager["list"]>[number] | undefined,
): ExtensionObservation {
  return {
    extensionId: desired.extensionId,
    desiredStatus: desired.status,
    desiredVersion: desired.version ?? null,
    observedStatus: observed?.status ?? "ABSENT",
    observedVersion: observed?.version ?? null,
    errorCode: observed?.lastErrorCode ?? null,
    errorMessage: null,
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof RuntimeError) return error.message;
  return error instanceof Error
    ? error.message.slice(0, 500)
    : "Extension reconciliation failed.";
}
