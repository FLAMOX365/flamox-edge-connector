import type { JsonValue } from "../sdk/extension.ts";
import type { ProtocolExecutor } from "./connector.ts";
import type { ExtensionManager } from "./extension-manager.ts";
import type {
  EdgeConnectorHttpResponse,
  EdgeConnectorRequestFrame,
} from "./generated/models.ts";
import { RuntimeError } from "./runtime-error.ts";

const maximumActionBodyBytes = 1024 * 1024;
const actionPathPattern =
  /^\/extensions\/([a-z][a-z0-9.-]*)\/actions\/([a-z][a-z0-9.-]*)$/u;

/** Maps the generic HTTP wire envelope onto explicitly installed actions only. */
export class ExtensionProtocolExecutor implements ProtocolExecutor {
  readonly #manager: Pick<ExtensionManager, "execute">;

  constructor(manager: Pick<ExtensionManager, "execute">) {
    this.#manager = manager;
  }

  /** Keeps the managed namespace from ever falling through to legacy proxy mode. */
  owns(frame: EdgeConnectorRequestFrame): boolean {
    return frame.request.url.startsWith("/extensions/");
  }

  async execute(
    frame: EdgeConnectorRequestFrame,
  ): Promise<EdgeConnectorHttpResponse> {
    if (frame.request.method !== "POST") {
      throw new RuntimeError(
        "EXTENSION_ROUTE_NOT_FOUND",
        "Extension actions only accept POST requests.",
      );
    }
    if (!frame.request.url.startsWith("/")) {
      throw new RuntimeError(
        "EXTENSION_ROUTE_NOT_FOUND",
        "Extension action URLs must be absolute paths.",
      );
    }

    const url = new URL(frame.request.url, "https://edge.invalid");
    if (url.search || url.hash) {
      throw new RuntimeError(
        "EXTENSION_ROUTE_NOT_FOUND",
        "Extension action URLs do not accept query strings or fragments.",
      );
    }
    const match = actionPathPattern.exec(url.pathname);
    if (!match) {
      throw new RuntimeError(
        "EXTENSION_ROUTE_NOT_FOUND",
        "No active extension action accepts this request.",
      );
    }

    const input = parseInput(frame.request.body);
    const output = await this.#manager.execute(
      frame.requestId,
      match[1],
      match[2],
      input,
    );
    return {
      statusCode: 200,
      headers: { "content-type": ["application/json; charset=utf-8"] },
      body: JSON.stringify(output),
    };
  }
}

function parseInput(body: string | null | undefined): JsonValue {
  if (body === undefined || body === null) {
    return null;
  }
  if (new TextEncoder().encode(body).byteLength > maximumActionBodyBytes) {
    throw new RuntimeError(
      "EXTENSION_INPUT_TOO_LARGE",
      `Extension action input exceeds ${maximumActionBodyBytes} bytes.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new RuntimeError(
      "INVALID_EXTENSION_INPUT",
      "Extension action input must be valid JSON.",
      { cause: error },
    );
  }
  if (!isJsonValue(parsed)) {
    throw new RuntimeError(
      "INVALID_EXTENSION_INPUT",
      "Extension action input must contain only JSON values.",
    );
  }
  return parsed;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null || typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}
