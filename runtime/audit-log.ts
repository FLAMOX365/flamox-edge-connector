import type { JsonValue } from "../sdk/extension.ts";

export type ConnectorAuditEvent = {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly type: string;
  readonly outcome: "SUCCEEDED" | "FAILED";
  readonly extensionId?: string;
  readonly details: Readonly<Record<string, JsonValue>>;
};

/** Durable, non-secret outbox for operational audit delivery to FLAMOX365. */
export class ConnectorAuditLog {
  #events: ConnectorAuditEvent[] = [];

  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async initialize(): Promise<void> {
    try {
      const info = await Deno.stat(this.path);
      if (!info.isFile || info.size > 5 * 1024 * 1024) invalid();
      const parsed: unknown = JSON.parse(await Deno.readTextFile(this.path));
      if (!Array.isArray(parsed)) invalid();
      this.#events = parsed.map(parseEvent);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  list(): readonly ConnectorAuditEvent[] {
    return [...this.#events];
  }

  async record(
    type: string,
    outcome: "SUCCEEDED" | "FAILED",
    details: Readonly<Record<string, JsonValue>> = {},
    extensionId?: string,
  ): Promise<ConnectorAuditEvent> {
    const event: ConnectorAuditEvent = {
      eventId: crypto.randomUUID(),
      occurredAt: this.now().toISOString(),
      type,
      outcome,
      extensionId,
      details,
    };
    parseEvent(event);
    this.#events.push(event);
    if (this.#events.length > 10_000) {
      this.#events.splice(0, this.#events.length - 10_000);
    }
    await this.persist();
    return event;
  }

  async acknowledge(eventIds: readonly string[]): Promise<void> {
    const acknowledged = new Set(eventIds);
    this.#events = this.#events.filter((event) =>
      !acknowledged.has(event.eventId)
    );
    await this.persist();
  }

  private async persist(): Promise<void> {
    const slash = Math.max(
      this.path.lastIndexOf("/"),
      this.path.lastIndexOf("\\"),
    );
    const directory = slash < 0 ? "." : this.path.slice(0, slash);
    await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${crypto.randomUUID()}`;
    try {
      await Deno.writeTextFile(
        temporary,
        `${JSON.stringify(this.#events)}\n`,
        { createNew: true, mode: 0o600 },
      );
      await Deno.rename(temporary, this.path);
    } catch (error) {
      await Deno.remove(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function parseEvent(value: unknown): ConnectorAuditEvent {
  if (!isRecord(value) || !isRecord(value.details)) invalid();
  if (
    typeof value.eventId !== "string" || typeof value.occurredAt !== "string" ||
    Number.isNaN(Date.parse(value.occurredAt)) ||
    typeof value.type !== "string" ||
    (value.outcome !== "SUCCEEDED" && value.outcome !== "FAILED") ||
    (value.extensionId !== undefined &&
      typeof value.extensionId !== "string") ||
    !Object.values(value.details).every(isJsonValue)
  ) invalid();
  return value as ConnectorAuditEvent;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new Error("Connector audit log is invalid.");
}
