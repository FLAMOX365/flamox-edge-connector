import { walk } from "@std/fs";
import { relative } from "@std/path";
import type { ExtensionManifest } from "./extension-manifest.ts";

const maximumPackageFiles = 1_000;
const maximumPackageFileBytes = 25 * 1024 * 1024;
const maximumPackageBytes = 100 * 1024 * 1024;

export type ExtensionReleaseDescriptor = {
  readonly extensionId: string;
  readonly version: string;
  readonly digest: string;
  readonly publisher: string;
  readonly publisherKeyId: string;
  readonly signature: string;
};

export interface ExtensionReleaseVerifier {
  verify(
    sourceDirectory: string,
    manifest: ExtensionManifest,
    release: ExtensionReleaseDescriptor,
  ): Promise<void>;
}

export function parseExtensionReleaseDescriptor(
  value: unknown,
): ExtensionReleaseDescriptor {
  if (!isRecord(value)) {
    throw new Error("Extension release descriptor must be an object.");
  }
  exactKeys(value, [
    "extensionId",
    "version",
    "digest",
    "publisher",
    "publisherKeyId",
    "signature",
  ], "Extension release descriptor");
  const descriptor: ExtensionReleaseDescriptor = {
    extensionId: requiredText(value.extensionId, "extensionId"),
    version: requiredText(value.version, "version"),
    digest: requiredText(value.digest, "digest"),
    publisher: requiredText(value.publisher, "publisher"),
    publisherKeyId: requiredText(value.publisherKeyId, "publisherKeyId"),
    signature: requiredText(value.signature, "signature"),
  };
  if (!/^sha256:[0-9a-f]{64}$/u.test(descriptor.digest)) {
    throw new Error("Extension release digest must be a SHA-256 digest.");
  }
  return descriptor;
}

export type TrustedPublisher = {
  readonly keyId: string;
  readonly publisher: string;
  readonly publicKey: JsonWebKey;
};

export type TrustedPublisherFile = {
  readonly schemaVersion: 1;
  readonly publishers: readonly TrustedPublisher[];
};

/** Verifies immutable release metadata against locally trusted Ed25519 keys. */
export class Ed25519ExtensionReleaseVerifier
  implements ExtensionReleaseVerifier {
  readonly #publishers: ReadonlyMap<string, TrustedPublisher>;

  constructor(publishers: readonly TrustedPublisher[]) {
    const indexed = new Map<string, TrustedPublisher>();
    for (const publisher of publishers) {
      if (indexed.has(publisher.keyId)) {
        throw new Error(
          `Trusted publisher key '${publisher.keyId}' is duplicated.`,
        );
      }
      indexed.set(publisher.keyId, publisher);
    }
    this.#publishers = indexed;
  }

  static async fromFile(
    path: string,
  ): Promise<Ed25519ExtensionReleaseVerifier> {
    return new Ed25519ExtensionReleaseVerifier(
      await readTrustedPublishersFile(path),
    );
  }

  async verify(
    sourceDirectory: string,
    manifest: ExtensionManifest,
    release: ExtensionReleaseDescriptor,
  ): Promise<void> {
    release = parseExtensionReleaseDescriptor(release);
    if (
      release.extensionId !== manifest.id ||
      release.version !== manifest.version ||
      release.publisher !== manifest.publisher
    ) {
      throw new Error(
        "Extension release metadata does not match its manifest.",
      );
    }
    const digest = await computeExtensionDigest(sourceDirectory);
    if (!constantTimeTextEquals(digest, release.digest)) {
      throw new Error(
        "Extension artifact digest does not match the signed release.",
      );
    }
    const trusted = this.#publishers.get(release.publisherKeyId);
    if (!trusted || trusted.publisher !== manifest.publisher) {
      throw new Error(
        `Extension publisher key '${release.publisherKeyId}' is not trusted for '${manifest.publisher}'.`,
      );
    }
    const key = await crypto.subtle.importKey(
      "jwk",
      trusted.publicKey,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      "Ed25519",
      key,
      decodeBase64(release.signature),
      new TextEncoder().encode(extensionReleaseSignaturePayload(release)),
    );
    if (!verified) {
      throw new Error("Extension release signature is invalid.");
    }
  }
}

export async function readTrustedPublishersFile(
  path: string,
): Promise<readonly TrustedPublisher[]> {
  let parsed: unknown;
  try {
    const info = await Deno.stat(path);
    if (!info.isFile || info.size > 1024 * 1024) {
      throw new Error("Trusted publishers file is missing or too large.");
    }
    parsed = JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    throw new Error(`Unable to read trusted publishers from '${path}'.`, {
      cause: error,
    });
  }
  return parseTrustedPublishers(parsed);
}

/** Computes a deterministic digest over relative paths, lengths and file hashes. */
export async function computeExtensionDigest(
  rootDirectory: string,
): Promise<string> {
  const entries: Array<{ path: string; size: number; hash: string }> = [];
  let totalSize = 0;
  for await (
    const entry of walk(rootDirectory, {
      includeDirs: false,
      includeSymlinks: true,
      followSymlinks: false,
    })
  ) {
    if (entry.isSymlink) {
      throw new Error(
        `Extension packages must not contain symbolic links ('${entry.path}').`,
      );
    }
    if (!entry.isFile) {
      continue;
    }
    if (entries.length >= maximumPackageFiles) {
      throw new Error(
        `Extension package exceeds ${maximumPackageFiles} files.`,
      );
    }
    const info = await Deno.stat(entry.path);
    if (info.size > maximumPackageFileBytes) {
      throw new Error(
        `Extension package file '${entry.path}' exceeds ${maximumPackageFileBytes} bytes.`,
      );
    }
    totalSize += info.size;
    if (totalSize > maximumPackageBytes) {
      throw new Error(
        `Extension package exceeds ${maximumPackageBytes} bytes.`,
      );
    }
    const bytes = await Deno.readFile(entry.path);
    entries.push({
      path: relative(rootDirectory, entry.path).replaceAll("\\", "/"),
      size: info.size,
      hash: hex(await crypto.subtle.digest("SHA-256", bytes)),
    });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const canonical = entries
    .map((entry) => `${entry.path}\0${entry.size}\0${entry.hash}\n`)
    .join("");
  return `sha256:${
    hex(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical),
      ),
    )
  }`;
}

/** Canonical bytes signed by an extension publisher. */
export function extensionReleaseSignaturePayload(
  release: Omit<ExtensionReleaseDescriptor, "signature">,
): string {
  return [
    "edge-extension-release-v1",
    release.extensionId,
    release.version,
    release.digest,
    release.publisher,
    release.publisherKeyId,
    "",
  ].join("\n");
}

export function encodeBase64(bytes: ArrayBuffer): string {
  const values = new Uint8Array(bytes);
  let binary = "";
  for (const value of values) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary);
}

function decodeBase64(value: string): ArrayBuffer {
  let binary: string;
  try {
    binary = atob(value);
  } catch (error) {
    throw new Error("Extension release signature is not valid base64.", {
      cause: error,
    });
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
    .buffer as ArrayBuffer;
}

export function parseTrustedPublishers(
  value: unknown,
): readonly TrustedPublisher[] {
  if (
    !isRecord(value) || value.schemaVersion !== 1 ||
    !Array.isArray(value.publishers)
  ) {
    throw new Error("Trusted publishers file must use schemaVersion 1.");
  }
  const allowedRootKeys = new Set(["$schema", "schemaVersion", "publishers"]);
  if (Object.keys(value).some((key) => !allowedRootKeys.has(key))) {
    throw new Error("Trusted publishers file contains unexpected fields.");
  }
  const publishers = value.publishers.map((nested, index) => {
    if (
      !isRecord(nested) ||
      typeof nested.keyId !== "string" ||
      typeof nested.publisher !== "string" ||
      !isRecord(nested.publicKey)
    ) {
      throw new Error(`Trusted publisher ${index} is invalid.`);
    }
    exactKeys(
      nested,
      ["keyId", "publisher", "publicKey"],
      `Trusted publisher ${index}`,
    );
    if (
      nested.publicKey.kty !== "OKP" || nested.publicKey.crv !== "Ed25519" ||
      typeof nested.publicKey.x !== "string" || nested.publicKey.x.length === 0
    ) {
      throw new Error(
        `Trusted publisher ${index} must contain an Ed25519 public JWK.`,
      );
    }
    return {
      keyId: requiredText(nested.keyId, `publisher ${index} keyId`),
      publisher: requiredText(nested.publisher, `publisher ${index} publisher`),
      publicKey: nested.publicKey as JsonWebKey,
    };
  });
  const keyIds = publishers.map((publisher) => publisher.keyId);
  if (new Set(keyIds).size !== keyIds.length) {
    throw new Error("Trusted publisher keys must be unique.");
  }
  return publishers;
}

/** Mutable union of locally configured and control-plane publisher keys. */
export class ManagedExtensionReleaseVerifier
  implements ExtensionReleaseVerifier {
  readonly #local: readonly TrustedPublisher[];
  #managed: readonly TrustedPublisher[] = [];

  constructor(local: readonly TrustedPublisher[] = []) {
    this.#local = local;
  }

  updateManagedPublishers(value: unknown): void {
    this.#managed = parseTrustedPublishers(value);
  }

  verify(
    sourceDirectory: string,
    manifest: ExtensionManifest,
    release: ExtensionReleaseDescriptor,
  ): Promise<void> {
    const keys = new Map<string, TrustedPublisher>();
    for (const publisher of [...this.#local, ...this.#managed]) {
      const existing = keys.get(publisher.keyId);
      if (
        existing &&
        (existing.publisher !== publisher.publisher ||
          JSON.stringify(existing.publicKey) !==
            JSON.stringify(publisher.publicKey))
      ) {
        throw new Error(
          `Publisher key '${publisher.keyId}' conflicts between trust sources.`,
        );
      }
      keys.set(publisher.keyId, publisher);
    }
    return new Ed25519ExtensionReleaseVerifier([...keys.values()]).verify(
      sourceDirectory,
      manifest,
      release,
    );
  }
}

function constantTimeTextEquals(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} contains unexpected or missing fields.`);
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Extension release ${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 10_000) {
    throw new Error(`Extension release ${field} is invalid.`);
  }
  return trimmed;
}
