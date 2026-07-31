import { assertEquals, assertThrows } from "@std/assert";
import {
  createExtensionBundle,
  extractExtensionBundle,
  parseExtensionBundle,
} from "./extension-bundle.ts";
import { computeExtensionDigest } from "./extension-integrity.ts";

Deno.test("extension bundle round-trips one signed package", async () => {
  const root = await Deno.makeTempDir();
  const source = `${root}/source`;
  const target = `${root}/target`;
  try {
    await Deno.mkdir(source);
    await Deno.writeTextFile(`${source}/extension-manifest.json`, "{}\n");
    await Deno.mkdir(`${source}/dist`);
    await Deno.writeTextFile(
      `${source}/dist/extension.js`,
      "export default {};\n",
    );
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
    assertEquals(bundle.files.map((file) => file.path), [
      "dist/extension.js",
      "extension-manifest.json",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("extension bundle rejects traversal and duplicate paths", () => {
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
