import lockfile from "proper-lockfile";
import { isNotFound } from "./files.ts";
import * as fs from "node:fs/promises";
import { copyTree as copy, walk } from "./files.ts";
import { join, relative, resolve } from "node:path";
import type { AnySchema } from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";
import type { JsonValue } from "@edge-connector/sdk/extension";
import type {
  ExtensionReleaseDescriptor,
  ExtensionReleaseVerifier,
} from "./extension-integrity.ts";
import { parseExtensionReleaseDescriptor } from "./extension-integrity.ts";
import {
  type ExtensionManifest,
  readExtensionManifest,
} from "./extension-manifest.ts";
import {
  type ExtensionGrant,
  type ExtensionPolicy,
  parseExtensionGrant,
} from "./extension-policy.ts";
import type { ExtensionSecretProvider } from "./extension-secrets.ts";
import type { ExtensionHostCapabilityProvider } from "./extension-host-capabilities.ts";
import type {
  ExtensionStateStore,
  InstalledExtensionRevision,
  InstalledExtensionState,
} from "./extension-state.ts";
import { ExtensionHost } from "./extension-host.ts";
import type { RuntimeLogger } from "./logger.ts";
import { createLogger } from "./logger.ts";
import { RuntimeError } from "./runtime-error.ts";

export type InstallExtensionRequest = {
  readonly sourceDirectory: string;
  readonly release: ExtensionReleaseDescriptor;
  readonly grant: ExtensionGrant;
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly activate: boolean;
  readonly managementMode?: "MANAGED" | "LOCAL";
};

export type ReconfigureExtensionRequest = {
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly grant?: ExtensionGrant;
};

export type ExtensionManagerOptions = {
  readonly dataDirectory: string;
  readonly stateStore: ExtensionStateStore;
  readonly verifier: ExtensionReleaseVerifier;
  readonly policy: ExtensionPolicy;
  readonly secrets: ExtensionSecretProvider;
  readonly hostCapabilities?: ExtensionHostCapabilityProvider;
  readonly logger?: RuntimeLogger;
  readonly now?: () => Date;
};

/** Owns immutable package installation, activation, rollback and execution. */
export class ExtensionManager {
  readonly #options: ExtensionManagerOptions;
  readonly #logger: RuntimeLogger;
  readonly #active = new Map<string, ExtensionHost>();
  #states = new Map<string, InstalledExtensionState>();
  #releaseLock: (() => void) | undefined;

  constructor(options: ExtensionManagerOptions) {
    this.#options = options;
    this.#logger = options.logger ?? createLogger();
  }

  async initialize(): Promise<void> {
    if (this.#releaseLock) {
      throw new Error("Extension manager is already initialized.");
    }
    await fs.mkdir(this.#options.dataDirectory, {
      recursive: true,
      mode: 0o700,
    });
    await this.acquireLock();
    try {
      await fs.mkdir(this.packagesDirectory(), {
        recursive: true,
        mode: 0o700,
      });
      await fs.mkdir(this.stagingDirectory(), {
        recursive: true,
        mode: 0o700,
      });
      const states = await this.#options.stateStore.load();
      this.#states = new Map(states.map((state) => [state.extensionId, state]));

      let changed = false;
      for (const state of states) {
        if (state.status !== "ACTIVE") {
          continue;
        }
        try {
          const host = await this.createVerifiedHost(state);
          this.#active.set(state.extensionId, host);
        } catch (error) {
          changed = true;
          this.#logger.error(
            `Unable to restore extension '${state.extensionId}'.`,
            error,
          );
          this.#states.set(state.extensionId, {
            ...state,
            status: "ERROR",
            lastErrorCode: "EXTENSION_RESTORE_FAILED",
          });
        }
      }
      if (changed) {
        await this.persist();
      }
    } catch (error) {
      this.releaseLock();
      throw error;
    }
  }

  list(): readonly InstalledExtensionState[] {
    return [...this.#states.values()].sort((left, right) =>
      left.extensionId.localeCompare(right.extensionId),
    );
  }

  async install(
    request: InstallExtensionRequest,
  ): Promise<InstalledExtensionState> {
    const release = parseExtensionReleaseDescriptor(request.release);
    const grant = parseExtensionGrant(request.grant);
    const configuration = parseExtensionConfiguration(request.configuration);
    const sourceDirectory = await fs.realpath(request.sourceDirectory);
    const manifest = await readExtensionManifest(sourceDirectory);
    this.#options.policy.authorize(manifest, grant, configuration);
    await this.#options.verifier.verify(sourceDirectory, manifest, release);
    await validateConfiguration(sourceDirectory, manifest, configuration);

    const staging = join(this.stagingDirectory(), crypto.randomUUID());
    let candidate: ExtensionHost | undefined;
    let createdPackagePath: string | undefined;
    try {
      await copy(sourceDirectory, staging, { overwrite: false });
      const copiedManifest = await readExtensionManifest(staging);
      this.assertSameManifest(manifest, copiedManifest);
      await this.#options.verifier.verify(staging, copiedManifest, release);

      const packagePath = this.releasePackagePath(release);
      const absolutePackagePath = this.resolvePackagePath(packagePath);
      await fs.mkdir(resolve(absolutePackagePath, ".."), {
        recursive: true,
        mode: 0o700,
      });
      if (await exists(absolutePackagePath)) {
        await fs.rm(staging, { recursive: true });
      } else {
        await fs.rename(staging, absolutePackagePath);
        createdPackagePath = absolutePackagePath;
        await sealPackage(absolutePackagePath);
      }

      const finalManifest = await readExtensionManifest(absolutePackagePath);
      this.assertSameManifest(copiedManifest, finalManifest);
      await this.#options.verifier.verify(
        absolutePackagePath,
        finalManifest,
        release,
      );
      const previousState = this.#states.get(manifest.id);

      // Always launch from the immutable final path. A worker must never
      // retain a dependency on the transient staging directory.
      if (
        request.activate ||
        finalManifest.lifecycle?.install ||
        finalManifest.lifecycle?.configure ||
        finalManifest.lifecycle?.migrate
      ) {
        candidate = this.createHost(
          absolutePackagePath,
          finalManifest,
          grant,
          configuration,
        );
        await candidate.start();
        if (previousState) {
          await this.runLifecycle(candidate, finalManifest, "migrate", {
            fromVersion: previousState.version,
            toVersion: manifest.version,
          });
        } else {
          await this.runLifecycle(candidate, finalManifest, "install", null);
        }
        await this.runLifecycle(candidate, finalManifest, "configure", null);
        if (request.activate) {
          await this.runLifecycle(candidate, finalManifest, "activate", null);
          await this.runHealth(candidate, finalManifest);
        }
      }

      const now = (this.#options.now ?? (() => new Date()))().toISOString();
      const state: InstalledExtensionState = {
        managementMode: request.managementMode ?? "LOCAL",
        extensionId: manifest.id,
        version: manifest.version,
        packagePath,
        status: request.activate ? "ACTIVE" : "DISABLED",
        release,
        grant,
        configuration,
        installedAt: now,
        activatedAt: request.activate ? now : null,
        lastErrorCode: null,
        history: previousState
          ? [revisionOf(previousState), ...(previousState.history ?? [])].slice(
              0,
              10,
            )
          : [],
      };
      this.#states.set(manifest.id, state);
      try {
        await this.persist();
      } catch (error) {
        if (previousState) {
          this.#states.set(manifest.id, previousState);
        } else {
          this.#states.delete(manifest.id);
        }
        throw error;
      }

      const previousHost = this.#active.get(manifest.id);
      if (request.activate && candidate) {
        this.#active.set(manifest.id, candidate);
      } else {
        this.#active.delete(manifest.id);
        candidate?.stop();
      }
      previousHost?.stop();
      // The transaction is committed. The outer failure cleanup must no
      // longer stop or delete the newly active release.
      candidate = undefined;
      createdPackagePath = undefined;
      this.#logger.info(
        `Extension '${manifest.id}' ${
          request.activate ? "activated" : "installed disabled"
        } at version ${manifest.version}.`,
      );
      return state;
    } catch (error) {
      candidate?.stop();
      if (createdPackagePath) {
        try {
          await fs.rm(createdPackagePath, { recursive: true });
        } catch (cleanupError) {
          if (!isNotFound(cleanupError)) {
            this.#logger.warn(
              "Unable to remove failed extension package.",
              cleanupError,
            );
          }
        }
      }
      try {
        await fs.rm(staging, { recursive: true });
      } catch (cleanupError) {
        if (!isNotFound(cleanupError)) {
          this.#logger.warn(
            "Unable to remove failed extension staging directory.",
            cleanupError,
          );
        }
      }
      throw error;
    }
  }

  async activate(extensionId: string): Promise<InstalledExtensionState> {
    const state = this.requiredState(extensionId);
    if (state.status === "ACTIVE" && this.#active.has(extensionId)) {
      return state;
    }
    const host = await this.createVerifiedHost(state, true);
    const now = (this.#options.now ?? (() => new Date()))().toISOString();
    const activeState: InstalledExtensionState = {
      ...state,
      status: "ACTIVE",
      activatedAt: now,
      lastErrorCode: null,
    };
    this.#states.set(extensionId, activeState);
    try {
      await this.persist();
    } catch (error) {
      this.#states.set(extensionId, state);
      host.stop();
      throw error;
    }
    this.#active.get(extensionId)?.stop();
    this.#active.set(extensionId, host);
    return activeState;
  }

  async disable(extensionId: string): Promise<InstalledExtensionState> {
    const state = this.requiredState(extensionId);
    const activeHost = this.#active.get(extensionId);
    if (activeHost) {
      await this.runLifecycle(
        activeHost,
        activeHost.manifest,
        "deactivate",
        null,
      );
    }
    const disabled: InstalledExtensionState = {
      ...state,
      status: "DISABLED",
      lastErrorCode: null,
    };
    this.#states.set(extensionId, disabled);
    try {
      await this.persist();
    } catch (error) {
      this.#states.set(extensionId, state);
      throw error;
    }
    activeHost?.stop();
    this.#active.delete(extensionId);
    return disabled;
  }

  /** Replaces configuration and grants using candidate health + atomic swap. */
  async reconfigure(
    extensionId: string,
    request: ReconfigureExtensionRequest,
  ): Promise<InstalledExtensionState> {
    const previous = this.requiredState(extensionId);
    const directory = this.resolvePackagePath(previous.packagePath);
    const manifest = await readExtensionManifest(directory);
    await this.#options.verifier.verify(directory, manifest, previous.release);
    const configuration = parseExtensionConfiguration(request.configuration);
    const grant = request.grant
      ? parseExtensionGrant(request.grant)
      : previous.grant;
    this.#options.policy.authorize(manifest, grant, configuration);
    await validateConfiguration(directory, manifest, configuration);

    let candidate: ExtensionHost | undefined;
    if (previous.status === "ACTIVE") {
      candidate = this.createHost(directory, manifest, grant, configuration);
      try {
        await candidate.start();
        await this.runLifecycle(candidate, manifest, "configure", null);
        await this.runHealth(candidate, manifest);
      } catch (error) {
        candidate.stop();
        throw error;
      }
    }

    const updated: InstalledExtensionState = {
      ...previous,
      grant,
      configuration,
      activatedAt:
        previous.status === "ACTIVE"
          ? (this.#options.now ?? (() => new Date()))().toISOString()
          : previous.activatedAt,
      lastErrorCode: null,
    };
    this.#states.set(extensionId, updated);
    try {
      await this.persist();
    } catch (error) {
      this.#states.set(extensionId, previous);
      candidate?.stop();
      throw error;
    }
    const previousHost = this.#active.get(extensionId);
    if (candidate) this.#active.set(extensionId, candidate);
    previousHost?.stop();
    return updated;
  }

  /** Atomically restores a previously verified release (newest by default). */
  async rollback(
    extensionId: string,
    version?: string,
  ): Promise<InstalledExtensionState> {
    const previous = this.requiredState(extensionId);
    const history = previous.history ?? [];
    const index =
      version === undefined
        ? 0
        : history.findIndex((revision) => revision.version === version);
    if (index < 0 || !history[index]) {
      throw new RuntimeError(
        "EXTENSION_ROLLBACK_NOT_AVAILABLE",
        version
          ? `Extension '${extensionId}' has no rollback release '${version}'.`
          : `Extension '${extensionId}' has no rollback release.`,
      );
    }
    const target = history[index];
    let candidate: ExtensionHost | undefined;
    if (previous.status === "ACTIVE") {
      candidate = await this.createVerifiedHost(target, true);
    } else {
      await this.verifyRevision(target);
    }
    const now = (this.#options.now ?? (() => new Date()))().toISOString();
    const remaining = history.filter(
      (_, candidateIndex) => candidateIndex !== index,
    );
    const rolledBack: InstalledExtensionState = {
      ...target,
      status: previous.status === "ACTIVE" ? "ACTIVE" : "DISABLED",
      activatedAt: previous.status === "ACTIVE" ? now : target.activatedAt,
      lastErrorCode: null,
      history: [revisionOf(previous), ...remaining].slice(0, 10),
    };
    this.#states.set(extensionId, rolledBack);
    try {
      await this.persist();
    } catch (error) {
      this.#states.set(extensionId, previous);
      candidate?.stop();
      throw error;
    }
    const previousHost = this.#active.get(extensionId);
    if (candidate) this.#active.set(extensionId, candidate);
    else this.#active.delete(extensionId);
    previousHost?.stop();
    return rolledBack;
  }

  async uninstall(extensionId: string): Promise<void> {
    const state = this.requiredState(extensionId);
    const directory = this.resolvePackagePath(state.packagePath);
    const manifest = await readExtensionManifest(directory);
    let lifecycleHost = this.#active.get(extensionId);
    let temporaryHost = false;
    if (!lifecycleHost && manifest.lifecycle?.uninstall) {
      lifecycleHost = await this.createVerifiedHost(state);
      temporaryHost = true;
    }
    if (lifecycleHost) {
      try {
        if (state.status === "ACTIVE") {
          await this.runLifecycle(lifecycleHost, manifest, "deactivate", null);
        }
        await this.runLifecycle(lifecycleHost, manifest, "uninstall", null);
      } finally {
        if (temporaryHost) lifecycleHost.stop();
      }
    }
    this.#states.delete(extensionId);
    try {
      await this.persist();
    } catch (error) {
      this.#states.set(extensionId, state);
      throw error;
    }
    this.#active.get(extensionId)?.stop();
    this.#active.delete(extensionId);
    const packagePaths = new Set([
      state.packagePath,
      ...(state.history ?? []).map((revision) => revision.packagePath),
    ]);
    for (const packagePath of packagePaths) {
      await fs
        .rm(this.resolvePackagePath(packagePath), {
          recursive: true,
        })
        .catch((error) => {
          if (!isNotFound(error)) throw error;
        });
    }
    this.#logger.info(`Extension '${extensionId}' was uninstalled.`);
  }

  execute(
    requestId: string,
    extensionId: string,
    action: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    const host = this.#active.get(extensionId);
    if (!host) {
      throw new RuntimeError(
        "EXTENSION_NOT_ACTIVE",
        `Extension '${extensionId}' is not active.`,
      );
    }
    return host.execute(requestId, action, input);
  }

  stop(): void {
    for (const host of this.#active.values()) {
      host.stop();
    }
    this.#active.clear();
    this.releaseLock();
  }

  private async createVerifiedHost(
    state: InstalledExtensionRevision,
    runActivationLifecycle = false,
  ): Promise<ExtensionHost> {
    const directory = this.resolvePackagePath(state.packagePath);
    const manifest = await readExtensionManifest(directory);
    this.#options.policy.authorize(manifest, state.grant, state.configuration);
    await this.#options.verifier.verify(directory, manifest, state.release);
    const host = this.createHost(
      directory,
      manifest,
      state.grant,
      state.configuration,
    );
    try {
      await host.start();
      if (runActivationLifecycle) {
        await this.runLifecycle(host, manifest, "activate", null);
      }
      await this.runHealth(host, manifest);
      return host;
    } catch (error) {
      host.stop();
      throw error;
    }
  }

  private async verifyRevision(
    state: InstalledExtensionRevision,
  ): Promise<void> {
    const directory = this.resolvePackagePath(state.packagePath);
    const manifest = await readExtensionManifest(directory);
    this.#options.policy.authorize(manifest, state.grant, state.configuration);
    await this.#options.verifier.verify(directory, manifest, state.release);
    await validateConfiguration(directory, manifest, state.configuration);
  }

  private createHost(
    directory: string,
    manifest: ExtensionManifest,
    grant: ExtensionGrant,
    configuration: Readonly<Record<string, JsonValue>>,
  ): ExtensionHost {
    return new ExtensionHost({
      extensionDirectory: directory,
      manifest,
      grant,
      configuration,
      secrets: this.#options.secrets,
      hostCapabilities: this.#options.hostCapabilities,
    });
  }

  private async runHealth(
    host: ExtensionHost,
    manifest: ExtensionManifest,
  ): Promise<void> {
    if (!manifest.health) {
      return;
    }
    await host.execute(
      `health-${crypto.randomUUID()}`,
      manifest.health.action,
      null,
      manifest.health.timeoutSeconds * 1_000,
    );
  }

  private async runLifecycle(
    host: ExtensionHost,
    manifest: ExtensionManifest,
    lifecycle: keyof NonNullable<ExtensionManifest["lifecycle"]>,
    input: JsonValue,
  ): Promise<void> {
    const action = manifest.lifecycle?.[lifecycle];
    if (!action) return;
    await host.execute(
      `lifecycle-${lifecycle}-${crypto.randomUUID()}`,
      action,
      input,
    );
  }

  private assertSameManifest(
    expected: ExtensionManifest,
    actual: ExtensionManifest,
  ): void {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error("Copied extension manifest changed during staging.");
    }
  }

  private releasePackagePath(release: ExtensionReleaseDescriptor): string {
    const digestDirectory = release.digest.replaceAll(":", "-");
    return [
      "packages",
      release.extensionId,
      release.version,
      digestDirectory,
    ].join("/");
  }

  private resolvePackagePath(packagePath: string): string {
    const root = resolve(this.#options.dataDirectory);
    const resolved = resolve(root, packagePath);
    const relativePath = relative(root, resolved).replaceAll("\\", "/");
    if (relativePath.startsWith("../") || relativePath === "..") {
      throw new Error(
        "Extension package path escapes the connector data directory.",
      );
    }
    return resolved;
  }

  private requiredState(extensionId: string): InstalledExtensionState {
    const state = this.#states.get(extensionId);
    if (!state) {
      throw new RuntimeError(
        "EXTENSION_NOT_INSTALLED",
        `Extension '${extensionId}' is not installed.`,
      );
    }
    return state;
  }

  private persist(): Promise<void> {
    return this.#options.stateStore.save([...this.#states.values()]);
  }

  private async acquireLock(): Promise<void> {
    const lockPath = join(
      this.#options.dataDirectory,
      ".extension-manager.lock",
    );
    try {
      this.#releaseLock = lockfile.lockSync(lockPath, {
        realpath: false,
        stale: 30_000,
        update: 10_000,
        retries: 0,
        onCompromised: (error) => {
          this.stop();
          throw error;
        },
      });
    } catch (error) {
      throw new Error(
        "Another connector process already owns the extension data directory.",
        { cause: error },
      );
    }
  }

  private releaseLock(): void {
    const release = this.#releaseLock;
    this.#releaseLock = undefined;
    release?.();
  }

  private packagesDirectory(): string {
    return join(this.#options.dataDirectory, "packages");
  }

  private stagingDirectory(): string {
    return join(this.#options.dataDirectory, ".staging");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

async function sealPackage(directory: string): Promise<void> {
  for await (const entry of walk(directory, {
    includeDirs: true,
    includeFiles: true,
    includeSymlinks: false,
  })) {
    await fs.chmod(entry.path, entry.isDirectory() ? 0o700 : 0o400);
  }
}

function revisionOf(
  state: InstalledExtensionState,
): InstalledExtensionRevision {
  return {
    managementMode: state.managementMode,
    extensionId: state.extensionId,
    version: state.version,
    packagePath: state.packagePath,
    release: state.release,
    grant: state.grant,
    configuration: state.configuration,
    installedAt: state.installedAt,
    activatedAt: state.activatedAt,
  };
}

export function parseExtensionConfiguration(
  value: unknown,
): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Extension configuration must be a JSON object.");
  }
  if (!isJsonValue(value, new Set())) {
    throw new Error("Extension configuration must contain only JSON values.");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error("Extension configuration must contain only JSON values.", {
      cause: error,
    });
  }
  if (new TextEncoder().encode(serialized).byteLength > 1024 * 1024) {
    throw new Error("Extension configuration exceeds 1048576 bytes.");
  }
  const normalized: unknown = JSON.parse(serialized);
  if (
    typeof normalized !== "object" ||
    normalized === null ||
    Array.isArray(normalized)
  ) {
    throw new Error("Extension configuration must contain only JSON values.");
  }
  return normalized as Readonly<Record<string, JsonValue>>;
}

function isJsonValue(
  value: unknown,
  ancestors: Set<object>,
): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  ancestors.add(value);
  const valid = (Array.isArray(value) ? value : Object.values(value)).every(
    (nested) => isJsonValue(nested, ancestors),
  );
  ancestors.delete(value);
  return valid;
}

async function validateConfiguration(
  extensionDirectory: string,
  manifest: ExtensionManifest,
  configuration: Readonly<Record<string, JsonValue>>,
): Promise<void> {
  if (!manifest.configurationSchema) {
    if (Object.keys(configuration).length > 0) {
      throw new Error(
        `Extension '${manifest.id}' does not declare a configuration schema.`,
      );
    }
    return;
  }
  const schemaPath = join(extensionDirectory, manifest.configurationSchema);
  const info = await fs.stat(schemaPath);
  if (!info.isFile() || info.size > 256 * 1024) {
    throw new Error("Extension configuration schema is missing or too large.");
  }
  let schema: unknown;
  try {
    schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));
  } catch (error) {
    throw new Error("Extension configuration schema is invalid JSON.", {
      cause: error,
    });
  }
  if (
    typeof schema !== "boolean" &&
    (typeof schema !== "object" || schema === null || Array.isArray(schema))
  ) {
    throw new Error(
      "Extension configuration schema must be a JSON schema object or boolean.",
    );
  }
  try {
    const validator = new Ajv2020Module.default({
      allErrors: true,
      coerceTypes: false,
      removeAdditional: false,
      strict: true,
      useDefaults: false,
      validateFormats: false,
    }).compile(schema as AnySchema);
    if (!validator(configuration)) {
      throw new Error(
        `Extension configuration does not satisfy the signed schema (${
          validator.errors?.length ?? 0
        } validation errors).`,
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Extension configuration does not satisfy")
    ) {
      throw error;
    }
    throw new Error("Extension configuration schema cannot be compiled.", {
      cause: error,
    });
  }
}
