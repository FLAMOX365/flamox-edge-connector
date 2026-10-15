import { environmentSnapshot } from "../runtime/environment.ts";
import { isNotFound } from "../runtime/files.ts";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { generatePublisherKey } from "../runtime/extension-publisher.ts";

export type CliConfig = {
  readonly schemaVersion: 1;
  readonly publisher?: {
    readonly name: string;
    readonly keyId: string;
    readonly privateKeyPath: string;
    readonly trustPath: string;
  };
  readonly cloud?: {
    readonly url: string;
    readonly accessToken?: string;
    readonly scope: "system" | "tenant";
  };
};

export function defaultCliDirectory(
  environment: Record<string, string | undefined> = environmentSnapshot(),
): string {
  if (environment.EDGE_EXTENSION_CLI_HOME?.trim()) {
    return environment.EDGE_EXTENSION_CLI_HOME.trim();
  }
  const base =
    environment.APPDATA ??
    environment.XDG_CONFIG_HOME ??
    (environment.HOME ? join(environment.HOME, ".config") : process.cwd());
  return join(base, "edge-extension-cli");
}

export class CliConfigStore {
  constructor(readonly directory = defaultCliDirectory()) {}

  get path(): string {
    return join(this.directory, "config.json");
  }

  async load(): Promise<CliConfig> {
    try {
      return parseCliConfig(JSON.parse(await fs.readFile(this.path, "utf8")));
    } catch (error) {
      if (isNotFound(error)) {
        return { schemaVersion: 1 };
      }
      throw new Error(`Unable to read CLI configuration '${this.path}'.`, {
        cause: error,
      });
    }
  }

  async save(config: CliConfig): Promise<void> {
    const parsed = parseCliConfig(config);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporary, this.path);
    } catch (error) {
      await fs.rm(temporary).catch(() => undefined);
      throw error;
    }
  }

  async initializePublisher(name: string, keyId: string): Promise<CliConfig> {
    const current = await this.load();
    if (current.publisher) {
      throw new Error(
        "A publisher identity already exists. Rotate it explicitly instead of overwriting it.",
      );
    }
    const pair = await generatePublisherKey(name, keyId);
    const keyDirectory = join(this.directory, "publishers");
    const privateKeyPath = join(keyDirectory, `${safeFileName(keyId)}.jwk`);
    const trustPath = join(keyDirectory, `${safeFileName(keyId)}.public.json`);
    await fs.mkdir(dirname(privateKeyPath), {
      recursive: true,
      mode: 0o700,
    });
    await writeNewJson(privateKeyPath, pair.privateKey);
    try {
      await writeNewJson(trustPath, pair.trust);
      const next: CliConfig = {
        ...current,
        publisher: { name, keyId, privateKeyPath, trustPath },
      };
      await this.save(next);
      return next;
    } catch (error) {
      await fs.rm(privateKeyPath).catch(() => undefined);
      await fs.rm(trustPath).catch(() => undefined);
      throw error;
    }
  }
}

export function parseCliConfig(value: unknown): CliConfig {
  if (!isRecord(value) || value.schemaVersion !== 1) invalidConfig();
  const rootKeys = Object.keys(value);
  if (
    rootKeys.some(
      (key) => !["schemaVersion", "publisher", "cloud"].includes(key),
    )
  ) {
    invalidConfig();
  }
  let publisher: CliConfig["publisher"];
  if (value.publisher !== undefined) {
    if (
      !isRecord(value.publisher) ||
      Object.keys(value.publisher).some(
        (key) =>
          !["name", "keyId", "privateKeyPath", "trustPath"].includes(key),
      )
    )
      invalidConfig();
    publisher = {
      name: text(value.publisher.name),
      keyId: text(value.publisher.keyId),
      privateKeyPath: text(value.publisher.privateKeyPath),
      trustPath: text(value.publisher.trustPath),
    };
  }
  let cloud: CliConfig["cloud"];
  if (value.cloud !== undefined) {
    if (
      !isRecord(value.cloud) ||
      Object.keys(value.cloud).some(
        (key) => !["url", "accessToken", "scope"].includes(key),
      )
    )
      invalidConfig();
    let url: URL;
    try {
      url = new URL(text(value.cloud.url));
    } catch {
      invalidConfig();
    }
    if (
      url.protocol !== "https:" &&
      url.hostname !== "localhost" &&
      url.hostname !== "127.0.0.1"
    ) {
      throw new Error("FLAMOX365 Cloud URL must use HTTPS outside localhost.");
    }
    if (value.cloud.scope !== "system" && value.cloud.scope !== "tenant") {
      invalidConfig();
    }
    cloud = {
      url: url.toString().replace(/\/$/u, ""),
      accessToken:
        value.cloud.accessToken === undefined
          ? undefined
          : text(value.cloud.accessToken),
      scope: value.cloud.scope,
    };
  }
  return { schemaVersion: 1, publisher, cloud };
}

async function writeNewJson(path: string, value: unknown): Promise<void> {
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function safeFileName(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,120}$/u.test(value)) {
    throw new Error("Publisher key id is not safe for a local file name.");
  }
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 16_384) {
    invalidConfig();
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidConfig(): never {
  throw new Error("Extension CLI configuration is invalid.");
}
