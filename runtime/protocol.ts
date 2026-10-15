import type {
  EdgeConnectorHeartbeatFrame,
  EdgeConnectorMessageFrame,
  EdgeConnectorRequestFrame,
  EdgeConnectorResponseFrame,
} from "./generated/models.ts";
import { RuntimeError } from "./runtime-error.ts";

export type WritableFrame =
  | EdgeConnectorResponseFrame
  | EdgeConnectorHeartbeatFrame;

const maximumFrameBytes = 2 * 1024 * 1024;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const methods = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export function parseMessageFrame(data: unknown): EdgeConnectorMessageFrame {
  if (typeof data !== "string") {
    throw new RuntimeError(
      "INVALID_FRAME",
      "WebSocket frames must be JSON strings",
    );
  }
  if (new TextEncoder().encode(data).byteLength > maximumFrameBytes) {
    throw new RuntimeError(
      "FRAME_TOO_LARGE",
      `WebSocket frame exceeds ${maximumFrameBytes} bytes`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new RuntimeError(
      "INVALID_FRAME",
      "WebSocket frame is not valid JSON",
      { cause: error },
    );
  }

  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    throw new RuntimeError(
      "INVALID_FRAME",
      "WebSocket frame must contain a string type",
    );
  }

  if (
    parsed.type !== "request" &&
    parsed.type !== "response" &&
    parsed.type !== "heartbeat"
  ) {
    throw new RuntimeError(
      "UNSUPPORTED_FRAME",
      `Unsupported frame type: ${parsed.type}`,
    );
  }

  if (parsed.type === "request") {
    validateRequestFrame(parsed);
  } else if (parsed.type === "response") {
    validateResponseFrame(parsed);
  } else {
    validateHeartbeatFrame(parsed);
  }

  return parsed as EdgeConnectorMessageFrame;
}

export function isRequestFrame(
  frame: EdgeConnectorMessageFrame,
): frame is EdgeConnectorRequestFrame {
  return frame.type === "request";
}

export function isHeartbeatFrame(
  frame: EdgeConnectorMessageFrame,
): frame is EdgeConnectorHeartbeatFrame {
  return frame.type === "heartbeat";
}

export function createHeartbeatFrame(): EdgeConnectorHeartbeatFrame {
  return {
    type: "heartbeat",
    sentAt: new Date().toISOString(),
  };
}

export function createResponseFrame(
  requestId: string,
  response: EdgeConnectorResponseFrame["response"],
): EdgeConnectorResponseFrame {
  return {
    type: "response",
    requestId,
    response,
  };
}

export function createErrorFrame(
  requestId: string,
  error: EdgeConnectorResponseFrame["error"],
): EdgeConnectorResponseFrame {
  return {
    type: "response",
    requestId,
    error,
  };
}

export function serializeFrame(frame: WritableFrame): string {
  return JSON.stringify(frame);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRequestFrame(frame: Record<string, unknown>): void {
  exactKeys(frame, ["type", "requestId", "request"]);
  requestId(frame.requestId);
  if (!isRecord(frame.request)) {
    invalid("Request frame request must be an object");
  }
  exactKeys(
    frame.request,
    ["method", "url"],
    ["headers", "body", "timeoutSeconds"],
  );
  if (
    typeof frame.request.method !== "string" ||
    !methods.has(frame.request.method)
  ) {
    invalid("Request method is unsupported");
  }
  if (
    typeof frame.request.url !== "string" ||
    frame.request.url.length === 0 ||
    frame.request.url.length > 4_096
  ) {
    invalid("Request URL must contain between 1 and 4096 characters");
  }
  optionalHeaders(frame.request.headers);
  if (
    frame.request.body !== undefined &&
    frame.request.body !== null &&
    typeof frame.request.body !== "string"
  ) {
    invalid("Request body must be a string or null");
  }
  if (frame.request.timeoutSeconds !== undefined) {
    boundedInteger(
      frame.request.timeoutSeconds,
      1,
      120,
      "Request timeoutSeconds",
    );
  }
}

function validateResponseFrame(frame: Record<string, unknown>): void {
  exactKeys(frame, ["type", "requestId"], ["response", "error"]);
  requestId(frame.requestId);
  const hasResponse = frame.response !== undefined;
  const hasError = frame.error !== undefined;
  if (hasResponse === hasError) {
    invalid("Response frame must contain exactly one of response or error");
  }
  if (hasResponse) {
    if (!isRecord(frame.response)) invalid("Response must be an object");
    exactKeys(frame.response, ["statusCode"], ["headers", "body"]);
    boundedInteger(frame.response.statusCode, 100, 599, "Response statusCode");
    optionalHeaders(frame.response.headers);
    if (
      frame.response.body !== undefined &&
      frame.response.body !== null &&
      typeof frame.response.body !== "string"
    ) {
      invalid("Response body must be a string or null");
    }
    return;
  }
  if (!isRecord(frame.error)) invalid("Response error must be an object");
  exactKeys(frame.error, ["code", "message"]);
  boundedText(frame.error.code, 1, 120, "Response error code");
  boundedText(frame.error.message, 1, 2_000, "Response error message");
}

function validateHeartbeatFrame(frame: Record<string, unknown>): void {
  exactKeys(frame, ["type"], ["sentAt"]);
  if (frame.sentAt !== undefined) {
    const sentAt = boundedText(frame.sentAt, 1, 100, "Heartbeat sentAt");
    if (Number.isNaN(Date.parse(sentAt))) {
      invalid("Heartbeat sentAt must be an ISO date-time");
    }
  }
}

function requestId(value: unknown): void {
  const parsed = boundedText(value, 1, 100, "Frame requestId");
  if (!uuidPattern.test(parsed)) {
    invalid("Frame requestId must be a UUID");
  }
}

function optionalHeaders(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) invalid("Headers must be an object");
  const entries = Object.entries(value);
  if (entries.length > 100) {
    invalid("Headers must not contain more than 100 fields");
  }
  for (const [name, nested] of entries) {
    if (name.length === 0 || name.length > 200 || !Array.isArray(nested)) {
      invalid("Header fields are invalid");
    }
    if (
      nested.length > 100 ||
      nested.some((item) => typeof item !== "string" || item.length > 8_192)
    ) {
      invalid(`Header '${name}' values are invalid`);
    }
  }
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const actual = new Set(Object.keys(value));
  for (const key of required) {
    if (!actual.has(key)) invalid(`Frame is missing required field '${key}'`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of actual) {
    if (!allowed.has(key)) invalid(`Frame contains unsupported field '${key}'`);
  }
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (
    !Number.isInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    invalid(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
}

function boundedText(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum
  ) {
    invalid(
      `${label} must contain between ${minimum} and ${maximum} characters`,
    );
  }
  return value;
}

function invalid(message: string): never {
  throw new RuntimeError("INVALID_FRAME", message);
}
