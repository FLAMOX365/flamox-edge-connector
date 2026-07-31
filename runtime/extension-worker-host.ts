import type { JsonValue } from "../sdk/extension.ts";
import { join, toFileUrl } from "@std/path";
import type { ExtensionManifest } from "./extension-manifest.ts";
import type { ExtensionGrant } from "./extension-policy.ts";
import type { ExtensionSecretProvider } from "./extension-secrets.ts";
import {
  DenyAllExtensionHostCapabilityProvider,
  type ExtensionHostCapabilityProvider,
} from "./extension-host-capabilities.ts";
import type {
  ExtensionWorkerInboundMessage,
  ExtensionWorkerOutboundMessage,
} from "./extension-worker-protocol.ts";
import { validateExtensionActionValue } from "./extension-action-contract.ts";
import { RuntimeError } from "./runtime-error.ts";

type PendingExecution = {
  readonly requestId: string;
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (reason: unknown) => void;
  readonly timeoutId: ReturnType<typeof setTimeout>;
};

export type ExtensionWorkerHostOptions = {
  readonly extensionDirectory: string;
  readonly manifest: ExtensionManifest;
  readonly grant: ExtensionGrant;
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly secrets: ExtensionSecretProvider;
  readonly hostCapabilities?: ExtensionHostCapabilityProvider;
  readonly startupTimeoutMs?: number;
};

/** Runs one extension in a worker with permissions narrowed to its local grant. */
export class ExtensionWorkerHost {
  readonly #options: ExtensionWorkerHostOptions;
  readonly #pending = new Map<string, PendingExecution>();
  #worker: Worker | undefined;
  #port: MessagePort | undefined;
  #ready: Promise<void> | undefined;
  #resolveReady: (() => void) | undefined;
  #rejectReady: ((reason: unknown) => void) | undefined;

  constructor(options: ExtensionWorkerHostOptions) {
    this.#options = options;
  }

  get manifest(): ExtensionManifest {
    return this.#options.manifest;
  }

  async start(): Promise<void> {
    if (this.#worker) {
      return this.#ready;
    }
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    const extensionDirectory = await Deno.realPath(
      this.#options.extensionDirectory,
    );
    const worker = new Worker(
      new URL("./extension-worker.ts", import.meta.url).href,
      {
        type: "module",
        name: this.#options.manifest.id,
        deno: {
          permissions: {
            env: false,
            ffi: false,
            import: false,
            net: [...this.#options.grant.network],
            read: [extensionDirectory],
            run: false,
            sys: false,
            write: false,
          },
        },
      },
    );
    this.#worker = worker;
    const channel = new MessageChannel();
    this.#port = channel.port1;
    channel.port1.onmessage = (
      event: MessageEvent<ExtensionWorkerOutboundMessage>,
    ) => {
      this.handleMessage(event.data);
    };
    channel.port1.onmessageerror = () => {
      this.fail(new Error("Extension worker emitted an unreadable message."));
    };
    channel.port1.start();
    worker.onerror = (event) => {
      event.preventDefault();
      this.fail(new Error(`Extension worker failed (${event.message}).`));
    };
    worker.postMessage({ type: "connect" }, [channel.port2]);
    const entrypointUrl = toFileUrl(join(
      extensionDirectory,
      this.#options.manifest.runtime.entrypoint,
    )).href;
    this.post({
      type: "init",
      entrypointUrl,
      expectedActions: this.#options.manifest.actions.map((action) =>
        action.name
      ),
    });

    const timeoutId = setTimeout(() => {
      this.fail(new Error("Extension worker did not become ready in time."));
    }, this.#options.startupTimeoutMs ?? 10_000);
    try {
      await this.#ready;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async execute(
    requestId: string,
    actionName: string,
    input: JsonValue,
    timeoutOverrideMs?: number,
  ): Promise<JsonValue> {
    await this.start();
    const action = this.#options.manifest.actions.find((candidate) =>
      candidate.name === actionName
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
    const secrets = await this.#options.secrets.resolve(
      this.#options.manifest.id,
      this.#options.grant.secrets,
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
      });
    });
    this.post({
      type: "execute",
      executionId,
      requestId,
      action: actionName,
      input,
      configuration: this.#options.configuration,
      secrets,
    });
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
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#port?.close();
    this.#port = undefined;
    this.failPending(
      new RuntimeError("EXTENSION_STOPPED", "Extension worker stopped."),
    );
  }

  private handleMessage(message: ExtensionWorkerOutboundMessage): void {
    if (message.type === "ready") {
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
    message: Extract<ExtensionWorkerOutboundMessage, { type: "host-call" }>,
  ): Promise<void> {
    const pending = this.#pending.get(message.executionId);
    if (!pending) {
      return;
    }
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
      this.post({
        type: "host-result",
        executionId: message.executionId,
        callId: message.callId,
        output,
      });
    } catch (error) {
      this.post({
        type: "host-error",
        executionId: message.executionId,
        callId: message.callId,
        code: error instanceof RuntimeError
          ? error.code
          : "HOST_CAPABILITY_FAILED",
        message: error instanceof Error
          ? error.message
          : "Host capability failed.",
      });
    }
  }

  private post(message: ExtensionWorkerInboundMessage): void {
    if (!this.#worker || !this.#port) {
      throw new RuntimeError(
        "EXTENSION_STOPPED",
        "Extension worker is not running.",
      );
    }
    this.#port.postMessage(message);
  }

  private fail(error: unknown): void {
    this.#rejectReady?.(error);
    this.#resolveReady = undefined;
    this.#rejectReady = undefined;
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#port?.close();
    this.#port = undefined;
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
