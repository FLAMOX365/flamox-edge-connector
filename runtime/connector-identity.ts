import { isNotFound } from "./files.ts";
import * as fs from "node:fs/promises";
export type ConnectorIdentity = {
  readonly schemaVersion: 1;
  readonly connectorId: string;
  readonly tenantId: string;
  readonly credentialSecret: string;
  readonly publicKey: JsonWebKey;
  readonly privateKey: JsonWebKey;
  readonly pairedAt: string;
};

export type ConnectorKeyPair = {
  readonly publicKey: JsonWebKey;
  readonly privateKey: JsonWebKey;
};

export type EncryptedConnectorSecret = {
  readonly algorithm: "RSA-OAEP-256";
  readonly ciphertext: string;
};

/** Persists the tenant-bound device credential with owner-only permissions. */
export class ConnectorIdentityStore {
  constructor(private readonly path: string) {}

  async load(): Promise<ConnectorIdentity | undefined> {
    try {
      const info = await fs.stat(this.path);
      if (!info.isFile() || info.size > 1024 * 1024) {
        throw new Error("Connector identity is missing or too large.");
      }
      return parseConnectorIdentity(
        JSON.parse(await fs.readFile(this.path, "utf8")),
      );
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw new Error("Unable to load the connector identity.", {
        cause: error,
      });
    }
  }

  async save(identity: ConnectorIdentity): Promise<void> {
    const parsed = parseConnectorIdentity(identity);
    const slash = Math.max(
      this.path.lastIndexOf("/"),
      this.path.lastIndexOf("\\"),
    );
    const directory = slash < 0 ? "." : this.path.slice(0, slash);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporary, this.path);
      await fs.chmod(this.path, 0o600);
    } catch (error) {
      await fs.rm(temporary).catch(() => undefined);
      throw error;
    }
  }
}

export async function generateConnectorKeyPair(): Promise<ConnectorKeyPair> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  return {
    publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
}

export async function decryptConnectorSecret(
  identity: ConnectorIdentity,
  value: EncryptedConnectorSecret,
): Promise<string> {
  if (value.algorithm !== "RSA-OAEP-256") {
    throw new Error("Connector secret envelope algorithm is unsupported.");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    identity.privateKey,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  let encrypted: Uint8Array;
  try {
    const binary = atob(value.ciphertext);
    encrypted = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch (error) {
    throw new Error("Connector secret ciphertext is invalid base64.", {
      cause: error,
    });
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    key,
    encrypted.buffer as ArrayBuffer,
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
}

export function parseConnectorIdentity(value: unknown): ConnectorIdentity {
  if (!isRecord(value)) invalid();
  exactKeys(value, [
    "schemaVersion",
    "connectorId",
    "tenantId",
    "credentialSecret",
    "publicKey",
    "privateKey",
    "pairedAt",
  ]);
  if (value.schemaVersion !== 1) invalid();
  const publicKey = rsaJwk(value.publicKey, false);
  const privateKey = rsaJwk(value.privateKey, true);
  const pairedAt = text(value.pairedAt, 100);
  if (Number.isNaN(Date.parse(pairedAt))) invalid();
  return {
    schemaVersion: 1,
    connectorId: identifier(value.connectorId),
    tenantId: identifier(value.tenantId),
    credentialSecret: text(value.credentialSecret, 1_000),
    publicKey,
    privateKey,
    pairedAt,
  };
}

function rsaJwk(value: unknown, privateKey: boolean): JsonWebKey {
  if (!isRecord(value)) invalid();
  if (
    value.kty !== "RSA" ||
    typeof value.n !== "string" ||
    typeof value.e !== "string" ||
    (privateKey && typeof value.d !== "string")
  )
    invalid();
  return value as JsonWebKey;
}

function identifier(value: unknown): string {
  const parsed = text(value, 200);
  if (!/^[A-Za-z0-9_-]+$/u.test(parsed)) invalid();
  return parsed;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    invalid();
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new Error("Connector identity is invalid.");
}
