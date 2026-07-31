export type ConnectorControlState = {
  readonly schemaVersion: 1;
  readonly desiredRevision: number;
  readonly commandSequence: number;
};

export class ConnectorControlStateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<ConnectorControlState> {
    try {
      const info = await Deno.stat(this.path);
      if (!info.isFile || info.size > 64 * 1024) invalid();
      const parsed: unknown = JSON.parse(await Deno.readTextFile(this.path));
      if (!isRecord(parsed)) invalid();
      if (
        parsed.schemaVersion !== 1 ||
        !Number.isSafeInteger(parsed.desiredRevision) ||
        Number(parsed.desiredRevision) < 0 ||
        !Number.isSafeInteger(parsed.commandSequence) ||
        Number(parsed.commandSequence) < 0
      ) invalid();
      return {
        schemaVersion: 1,
        desiredRevision: Number(parsed.desiredRevision),
        commandSequence: Number(parsed.commandSequence),
      };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return { schemaVersion: 1, desiredRevision: 0, commandSequence: 0 };
      }
      throw error;
    }
  }

  async save(state: ConnectorControlState): Promise<void> {
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
        `${JSON.stringify(state)}\n`,
        { createNew: true, mode: 0o600 },
      );
      await Deno.rename(temporary, this.path);
    } catch (error) {
      await Deno.remove(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new Error("Connector control state is invalid.");
}
