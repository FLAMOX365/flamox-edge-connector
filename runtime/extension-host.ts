import { fork, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { JsonValue } from "@edge-connector/sdk/extension";
import { join } from "node:path";
import type { ExtensionManifest } from "./extension-manifest.ts";
import type { ExtensionGrant } from "./extension-policy.ts";
import type { ExtensionSecretProvider } from "./extension-secrets.ts";
import {
  DenyAllExtensionHostCapabilityProvider,
  type ExtensionHostCapabilityProvider,
} from "./extension-host-capabilities.ts";
import type {
  ExtensionInboundMessage,
  ExtensionOutboundMessage,
} from "./extension-messages.ts";
import { validateExtensionActionValue } from "./extension-action-contract.ts";
import { RuntimeError } from "./runtime-error.ts";

type PendingExecution = {
  readonly requestId: string;
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (reason: unknown) => void;
  readonly timeoutId: ReturnType<typeof setTimeout>;
  readonly hostCallIds: Set<string>;
};

export type ExtensionHostOptions = {
  readonly extensionDirectory: string;
  readonly manifest: ExtensionManifest;
  readonly grant: ExtensionGrant;
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly secrets: ExtensionSecretProvider;
  readonly hostCapabilities?: ExtensionHostCapabilityProvider;
  readonly startupTimeoutMs?: number;
};

/** Runs one extension in an OS sandbox with an authenticated, private network proxy. */
export class ExtensionHost {
  readonly #options: ExtensionHostOptions;
  readonly #pending = new Map<string, PendingExecution>();
  #worker: ChildProcess | undefined;
  #ready: Promise<void> | undefined;
  #resolveReady: (() => void) | undefined;
  #rejectReady: ((reason: unknown) => void) | undefined;

  constructor(options: ExtensionHostOptions) {
    this.#options = options;
  }

  get manifest(): ExtensionManifest {
    return this.#options.manifest;
  }

  async start(): Promise<void> {
    if (this.#ready) return this.#ready;
    const ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#ready = ready;
    void ready.catch(() => undefined);
    try {
      const extensionDirectory = await realpath(
        this.#options.extensionDirectory,
      );
      if (this.#ready !== ready)
        throw new Error("Extension startup was cancelled.");
      const supervisor = new URL(
        import.meta.url.endsWith(".ts")
          ? "./extension-sandbox.ts"
          : "./extension-sandbox.js",
        import.meta.url,
      );
      const worker = fork(supervisor, [], {
        execArgv: import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : [],
        env: {
          PATH: process.env.PATH,
          ...(process.platform === "win32"
            ? {
                SystemRoot: process.env.SystemRoot,
                TEMP: process.env.TEMP,
                TMP: process.env.TMP,
              }
            : {}),
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      this.#worker = worker;
      worker.on("message", (message: unknown) => {
        if (this.#worker === worker) this.handleMessage(message);
      });
      worker.on("error", () => {
        if (this.#worker === worker)
          this.fail(new Error("Extension sandbox process failed."));
      });
      worker.once("exit", () => {
        if (this.#worker === worker)
          this.fail(new Error("Extension sandbox process stopped."));
      });
      worker.send({
        type: "sandbox-start",
        extensionDirectory,
        network: this.#options.grant.network,
        workerPath: fileURLToPath(
          new URL(
            import.meta.url.endsWith(".ts")
              ? "../dist/runtime/extension-process.mjs"
              : "./extension-process.mjs",
            import.meta.url,
          ),
        ),
      });
      this.post({
        type: "init",
        entrypointUrl: pathToFileURL(
          join(extensionDirectory, this.#options.manifest.runtime.entrypoint),
        ).href,
        expectedActions: this.#options.manifest.actions.map(
          (action) => action.name,
        ),
      });
      const timeoutId = setTimeout(
        () =>
          this.fail(
            new Error("Extension sandbox did not become ready in time."),
          ),
        this.#options.startupTimeoutMs ?? 10_000,
      );
      try {
        await ready;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      if (this.#ready === ready) this.fail(error);
      throw error;
    }
  }

  async execute(
    requestId: string,
    actionName: string,
    input: JsonValue,
    timeoutOverrideMs?: number,
  ): Promise<JsonValue> {
    await this.start();
    if (this.#pending.size >= 32)
      throw new RuntimeError(
        "EXTENSION_BUSY",
        "The extension execution limit was reached.",
      );
    const action = this.#options.manifest.actions.find(
      (candidate) => candidate.name === actionName,
    );
    if (!action) {
      throw new RuntimeError(
        "EXTENSION_ACTION_NOT_FOUND",
        `Extension action '${actionName}' is not declared.`,
      );
    }
    await validateExtensionActionValue(
      this.#options.extensionDirectory,
      this.#options.manifest,
      actionName,
      "input",
      input,
    );
    const resolvedSecrets = await this.#options.secrets.resolve(
      this.#options.manifest.id,
      this.#options.grant.secrets,
    );
    const secrets = Object.fromEntries(
      this.#options.grant.secrets.map((name) => [name, resolvedSecrets[name]]),
    );
    if (this.#pending.size >= 32)
      throw new RuntimeError(
        "EXTENSION_BUSY",
        "The extension execution limit was reached.",
      );
    const executionId = crypto.randomUUID();
    const timeoutMs = timeoutOverrideMs ?? action.timeoutSeconds * 1_000;
    const result = new Promise<JsonValue>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.#pending.delete(executionId);
        reject(
          new RuntimeError(
            "EXTENSION_ACTION_TIMEOUT",
            "Extension action timed out.",
          ),
        );
        this.stop();
      }, timeoutMs);
      this.#pending.set(executionId, {
        requestId,
        resolve,
        reject,
        timeoutId,
        hostCallIds: new Set(),
      });
    });
    try {
      this.post({
        type: "execute",
        executionId,
        requestId,
        action: actionName,
        input,
        configuration: this.#options.configuration,
        secrets,
      });
    } catch (error) {
      this.fail(error);
    }
    const output = await result;
    await validateExtensionActionValue(
      this.#options.extensionDirectory,
      this.#options.manifest,
      actionName,
      "output",
      output,
    );
    return output;
  }

  stop(): void {
    this.fail(
      new RuntimeError("EXTENSION_STOPPED", "Extension process stopped."),
    );
  }

  private handleMessage(value: unknown): void {
    if (!validMessage(value)) {
      this.fail(new Error("Extension emitted an invalid protocol message."));
      return;
    }
    const message = value;
    if (message.type === "ready") {
      const expected = this.#options.manifest.actions
        .map((action) => action.name)
        .sort();
      if (
        JSON.stringify([...message.actions].sort()) !== JSON.stringify(expected)
      ) {
        this.fail(
          new Error("Extension actions do not match the signed manifest."),
        );
        return;
      }
      this.#resolveReady?.();
      this.#resolveReady = undefined;
      this.#rejectReady = undefined;
      return;
    }
    if (message.type === "error" && message.executionId === null) {
      this.fail(new Error(`${message.message} (${message.errorName})`));
      return;
    }
    if (message.type === "host-call") {
      void this.handleHostCall(message);
      return;
    }
    const executionId = message.executionId;
    if (executionId === null) {
      return;
    }
    const pending = this.#pending.get(executionId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeoutId);
    this.#pending.delete(executionId);
    if (message.type === "result") {
      pending.resolve(message.output);
      return;
    }
    pending.reject(new RuntimeError(message.code, message.message));
  }

  private async handleHostCall(
    message: Extract<ExtensionOutboundMessage, { type: "host-call" }>,
  ): Promise<void> {
    const pending = this.#pending.get(message.executionId);
    if (!pending) {
      return;
    }
    if (pending.hostCallIds.has(message.callId)) return;
    if (pending.hostCallIds.size >= 32) {
      this.post({
        type: "host-error",
        executionId: message.executionId,
        callId: message.callId,
        code: "HOST_CAPABILITY_LIMIT",
        message: "The host-call limit was reached.",
      });
      return;
    }
    pending.hostCallIds.add(message.callId);
    if (
      !this.#options.manifest.capabilities.includes(message.capability) ||
      !this.#options.grant.capabilities.includes(message.capability)
    ) {
      this.post({
        type: "host-error",
        executionId: message.executionId,
        callId: message.callId,
        code: "HOST_CAPABILITY_DENIED",
        message: `Host capability '${message.capability}' is not granted.`,
      });
      return;
    }
    try {
      const output = await (
        this.#options.hostCapabilities ??
        new DenyAllExtensionHostCapabilityProvider()
      ).invoke({
        extensionId: this.#options.manifest.id,
        requestId: pending.requestId,
        capability: message.capability,
        operation: message.operation,
        input: message.input,
      });
      if (this.#pending.get(message.executionId) !== pending) return;
      this.post({
        type: "host-result",
        executionId: message.executionId,
        callId: message.callId,
        output,
      });
    } catch (error) {
      if (this.#pending.get(message.executionId) !== pending) return;
      this.post({
        type: "host-error",
        executionId: message.executionId,
        callId: message.callId,
        code:
          error instanceof RuntimeError ? error.code : "HOST_CAPABILITY_FAILED",
        message:
          error instanceof Error ? error.message : "Host capability failed.",
      });
    }
  }

  private post(message: ExtensionInboundMessage): void {
    if (!this.#worker?.connected) {
      throw new RuntimeError(
        "EXTENSION_STOPPED",
        "Extension worker is not running.",
      );
    }
    if (Buffer.byteLength(JSON.stringify(message)) > 16 * 1024 * 1024)
      throw new Error("Extension message exceeds the protocol limit.");
    const worker = this.#worker;
    worker.send(message, (error) => {
      if (error && this.#worker === worker)
        this.fail(new Error("Extension communication stopped."));
    });
  }

  private fail(error: unknown): void {
    this.#ready = undefined;
    this.#rejectReady?.(error);
    this.#resolveReady = undefined;
    this.#rejectReady = undefined;
    this.#worker?.kill("SIGTERM");
    this.#worker = undefined;
    this.failPending(error);
  }

  private failPending(error: unknown): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function validMessage(value: unknown): value is ExtensionOutboundMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const message = value as Record<string, unknown>;
  const text = (value: unknown, maximum = 128) =>
    typeof value === "string" && value.length > 0 && value.length <= maximum;
  if (message.type === "ready")
    return (
      Array.isArray(message.actions) &&
      message.actions.length <= 128 &&
      message.actions.every((action) => text(action))
    );
  if (message.type === "result")
    return text(message.executionId) && Object.hasOwn(message, "output");
  if (message.type === "error")
    return (
      (message.executionId === null || text(message.executionId)) &&
      text(message.code) &&
      text(message.message, 2000) &&
      text(message.errorName)
    );
  if (message.type === "host-call")
    return (
      text(message.executionId) &&
      text(message.callId) &&
      text(message.capability) &&
      text(message.operation) &&
      Object.hasOwn(message, "input")
    );
  return false;
}
