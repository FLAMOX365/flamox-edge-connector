import {
  computeExtensionDigest,
  encodeBase64,
  type ExtensionReleaseDescriptor,
  extensionReleaseSignaturePayload,
  type TrustedPublisherFile,
} from "./extension-integrity.ts";
import { readExtensionManifest } from "./extension-manifest.ts";

export type PublisherKeyPair = {
  readonly privateKey: JsonWebKey;
  readonly trust: TrustedPublisherFile;
};

/** Creates one local Ed25519 publisher identity without sending private data. */
export async function generatePublisherKey(
  publisher: string,
  keyId: string,
): Promise<PublisherKeyPair> {
  publisher = requiredText(publisher, "publisher");
  keyId = requiredText(keyId, "key id");
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    privateKey,
    trust: {
      schemaVersion: 1,
      publishers: [{ publisher, keyId, publicKey }],
    },
  };
}

/** Produces the immutable Store release descriptor for one package directory. */
export async function signExtensionRelease(
  sourceDirectory: string,
  privateKey: unknown,
  publisherKeyId: string,
): Promise<ExtensionReleaseDescriptor> {
  const manifest = await readExtensionManifest(sourceDirectory);
  const key = parsePrivateKey(privateKey);
  publisherKeyId = requiredText(publisherKeyId, "publisher key id");
  const unsigned = {
    extensionId: manifest.id,
    version: manifest.version,
    digest: await computeExtensionDigest(sourceDirectory),
    publisher: manifest.publisher,
    publisherKeyId,
  };
  const imported = await crypto.subtle.importKey("jwk", key, "Ed25519", false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign(
    "Ed25519",
    imported,
    new TextEncoder().encode(extensionReleaseSignaturePayload(unsigned)),
  );
  return { ...unsigned, signature: encodeBase64(signature) };
}

function parsePrivateKey(value: unknown): JsonWebKey {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as JsonWebKey).kty !== "OKP" ||
    (value as JsonWebKey).crv !== "Ed25519" ||
    typeof (value as JsonWebKey).x !== "string" ||
    typeof (value as JsonWebKey).d !== "string"
  ) {
    throw new Error("Publisher private key must be an Ed25519 private JWK.");
  }
  return value as JsonWebKey;
}

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new Error(`Extension ${name} is invalid.`);
  }
  return normalized;
}
