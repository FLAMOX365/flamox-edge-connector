import { isNotFound } from "./files.ts";
import * as fs from "node:fs/promises";
export type ConnectorControlState = {
  readonly schemaVersion: 1;
  readonly desiredRevision: number;
  readonly commandSequence: number;
};

export class ConnectorControlStateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<ConnectorControlState> {
    try {
      const info = await fs.stat(this.path);
      if (!info.isFile() || info.size > 64 * 1024) invalid();
      const parsed: unknown = JSON.parse(await fs.readFile(this.path, "utf8"));
      if (!isRecord(parsed)) invalid();
      if (
        parsed.schemaVersion !== 1 ||
        !Number.isSafeInteger(parsed.desiredRevision) ||
        Number(parsed.desiredRevision) < 0 ||
        !Number.isSafeInteger(parsed.commandSequence) ||
        Number(parsed.commandSequence) < 0
      )
        invalid();
      return {
        schemaVersion: 1,
        desiredRevision: Number(parsed.desiredRevision),
        commandSequence: Number(parsed.commandSequence),
      };
    } catch (error) {
      if (isNotFound(error)) {
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
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporary, this.path);
    } catch (error) {
      await fs.rm(temporary).catch(() => undefined);
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
