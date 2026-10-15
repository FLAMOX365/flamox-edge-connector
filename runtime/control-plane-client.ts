import type { JsonValue } from "@edge-connector/sdk/extension";
import type {
  ConnectorIdentity,
  ConnectorKeyPair,
} from "./connector-identity.ts";
import {
  type ConnectorCommandBatch,
  type ConnectorDesiredState,
  parseCommandBatch,
  parseDesiredState,
} from "./control-plane-contract.ts";
import {
  type ExtensionBundle,
  parseExtensionBundle,
} from "./extension-bundle.ts";

export type ConnectorPairingResult = {
  readonly connectorId: string;
  readonly tenantId: string;
  readonly credentialSecret: string;
};

export type ObservedStatePayload = {
  readonly schemaVersion: 1;
  readonly desiredRevision: number;
  readonly observedAt: string;
  readonly extensions: readonly unknown[];
};

export type CommandResultPayload = {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly commandId: string;
  readonly status: "SUCCEEDED" | "FAILED" | "EXPIRED";
  readonly output?: JsonValue;
  readonly errorCode?: string;
  readonly errorMessage?: string;
};

export type AuditPayload = {
  readonly schemaVersion: 1;
  readonly events: readonly unknown[];
};

export class ControlPlaneClient {
  readonly #baseUrl: URL;

  constructor(
    baseUrl: string,
    private readonly identity?: ConnectorIdentity,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.#baseUrl = new URL(ensureTrailingSlash(baseUrl));
  }

  async pair(
    pairingCode: string,
    displayName: string,
    keys: ConnectorKeyPair,
  ): Promise<ConnectorPairingResult> {
    const value = await this.requestJson(
      "edge/connectors/pair",
      {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          pairingCode,
          displayName,
          publicKey: keys.publicKey,
        }),
      },
      false,
    );
    if (!isRecord(value)) invalid("Pairing response");
    exactKeys(value, ["connectorId", "tenantId", "credentialSecret"]);
    return {
      connectorId: identifier(value.connectorId),
      tenantId: identifier(value.tenantId),
      credentialSecret: text(value.credentialSecret, 1_000),
    };
  }

  async getDesiredState(afterRevision: number): Promise<ConnectorDesiredState> {
    return parseDesiredState(
      await this.requestJson(
        `edge/connectors/control/desired?afterRevision=${afterRevision}`,
      ),
    );
  }

  async downloadBundle(pathOrUrl: string): Promise<ExtensionBundle> {
    const url = new URL(pathOrUrl, this.#baseUrl);
    if (url.origin !== this.#baseUrl.origin) {
      throw new Error("Extension bundle URL must use the management origin.");
    }
    return parseExtensionBundle(
      await this.requestJson(url, {}, true, 150 * 1024 * 1024),
    );
  }

  async reportObservedState(payload: ObservedStatePayload): Promise<void> {
    await this.requestJson("edge/connectors/control/observed", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async getCommands(afterSequence: number): Promise<ConnectorCommandBatch> {
    return parseCommandBatch(
      await this.requestJson(
        `edge/connectors/control/commands?afterSequence=${afterSequence}`,
      ),
    );
  }

  async reportCommandResult(payload: CommandResultPayload): Promise<void> {
    await this.requestJson("edge/connectors/control/command-results", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async reportAudit(payload: AuditPayload): Promise<void> {
    await this.requestJson("edge/connectors/control/audit", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  private async requestJson(
    pathOrUrl: string | URL,
    init: RequestInit = {},
    authenticated = true,
    maximumResponseBytes = 10 * 1024 * 1024,
  ): Promise<unknown> {
    const url =
      pathOrUrl instanceof URL
        ? pathOrUrl
        : new URL(pathOrUrl.replace(/^\/+/, ""), this.#baseUrl);
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (authenticated) {
      if (!this.identity) throw new Error("Connector identity is required.");
      headers.set(
        "authorization",
        `EdgeConnector ${this.identity.connectorId}.${this.identity.credentialSecret}`,
      );
    }
    const response = await this.fetcher(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(
        `Control-plane request failed with HTTP ${response.status}.`,
      );
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > maximumResponseBytes) {
      throw new Error("Control-plane response is too large.");
    }
    if (!response.body) throw new Error("Control-plane response is empty.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumResponseBytes) {
        await reader.cancel();
        throw new Error("Control-plane response is too large.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch (error) {
      throw new Error("Control-plane response is not valid JSON.", {
        cause: error,
      });
    }
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid("Object");
}

function identifier(value: unknown): string {
  const parsed = text(value, 200);
  if (!/^[A-Za-z0-9_-]+$/u.test(parsed)) invalid("Identifier");
  return parsed;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum) {
    invalid("Text");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(label: string): never {
  throw new Error(`${label} is invalid.`);
}
