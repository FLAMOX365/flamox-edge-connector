import { test } from "node:test";
import { makeTempDirectory } from "./files.ts";
import * as fs from "node:fs/promises";
import { assertEquals, assertRejects } from "../test/assert.ts";
import {
  computeExtensionDigest,
  Ed25519ExtensionReleaseVerifier,
  encodeBase64,
  type ExtensionReleaseDescriptor,
  extensionReleaseSignaturePayload,
} from "./extension-integrity.ts";
import { parseExtensionManifest } from "./extension-manifest.ts";

test("Ed25519ExtensionReleaseVerifier accepts an immutable signed package and rejects tampering", async () => {
  const directory = await makeTempDirectory();
  try {
    const manifest = parseExtensionManifest({
      schemaVersion: 2,
      id: "system.diagnostics",
      displayName: "Diagnostics",
      description: "Reports diagnostic state.",
      publisher: "FLAMOX365",
      version: "1.0.0",
      runtime: { kind: "node-process", entrypoint: "extension.ts" },
      capabilities: ["system.diagnostics.read"],
      permissions: { network: [], secrets: [] },
      actions: [{ name: "status", idempotent: true, timeoutSeconds: 5 }],
    });
    await fs.writeFile(
      `${directory}/extension-manifest.json`,
      JSON.stringify(manifest),
    );
    await fs.writeFile(
      `${directory}/extension.ts`,
      "export default { actions: {} };\n",
    );
    const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const digest = await computeExtensionDigest(directory);
    const unsigned = {
      extensionId: manifest.id,
      version: manifest.version,
      digest,
      publisher: manifest.publisher,
      publisherKeyId: "publisher-1",
    };
    const signature = await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      new TextEncoder().encode(extensionReleaseSignaturePayload(unsigned)),
    );
    const release: ExtensionReleaseDescriptor = {
      ...unsigned,
      signature: encodeBase64(signature),
    };
    const verifier = new Ed25519ExtensionReleaseVerifier([
      {
        keyId: "publisher-1",
        publisher: "FLAMOX365",
        publicKey: await crypto.subtle.exportKey("jwk", keys.publicKey),
      },
    ]);

    await verifier.verify(directory, manifest, release);
    assertEquals(release.digest.startsWith("sha256:"), true);

    await fs.writeFile(
      `${directory}/extension.ts`,
      "export default { tampered: true };\n",
    );
    await assertRejects(
      () => verifier.verify(directory, manifest, release),
      Error,
      "digest does not match",
    );
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});
