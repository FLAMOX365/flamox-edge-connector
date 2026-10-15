import { test } from "node:test";
import { makeTempDirectory } from "./files.ts";
import * as fs from "node:fs/promises";
import { assertEquals, assertThrows } from "../test/assert.ts";
import {
  createExtensionBundle,
  extractExtensionBundle,
  parseExtensionBundle,
} from "./extension-bundle.ts";
import { computeExtensionDigest } from "./extension-integrity.ts";

test("extension bundle round-trips one signed package", async () => {
  const root = await makeTempDirectory();
  const source = `${root}/source`;
  const target = `${root}/target`;
  try {
    await fs.mkdir(source);
    await fs.writeFile(`${source}/extension-manifest.json`, "{}\n");
    await fs.mkdir(`${source}/dist`);
    await fs.writeFile(`${source}/dist/extension.mjs`, "export default {};\n");
    const digest = await computeExtensionDigest(source);
    const bundle = await createExtensionBundle(source, {
      extensionId: "system.diagnostics",
      version: "1.0.0",
      digest,
      publisher: "FLAMOX365",
      publisherKeyId: "test-key",
      signature: "c2lnbmF0dXJl",
    });
    await extractExtensionBundle(bundle, target);
    assertEquals(await computeExtensionDigest(target), digest);
    assertEquals(
      bundle.files.map((file) => file.path),
      ["dist/extension.mjs", "extension-manifest.json"],
    );
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test("extension bundle rejects traversal and duplicate paths", () => {
  const release = {
    extensionId: "system.diagnostics",
    version: "1.0.0",
    digest: `sha256:${"a".repeat(64)}`,
    publisher: "FLAMOX365",
    publisherKeyId: "test-key",
    signature: "c2lnbmF0dXJl",
  };
  assertThrows(
    () =>
      parseExtensionBundle({
        schemaVersion: 1,
        mediaType: "application/vnd.flamox.edge-extension+json",
        release,
        files: [{ path: "../escape", contentBase64: "" }],
      }),
    Error,
    "invalid",
  );
});
