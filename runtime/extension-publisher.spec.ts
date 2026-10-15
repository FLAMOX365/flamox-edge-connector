import { test } from "node:test";
import { makeTempDirectory } from "./files.ts";
import * as fs from "node:fs/promises";
import { assertEquals, assertRejects } from "../test/assert.ts";
import { Ed25519ExtensionReleaseVerifier } from "./extension-integrity.ts";
import { readExtensionManifest } from "./extension-manifest.ts";
import {
  generatePublisherKey,
  signExtensionRelease,
} from "./extension-publisher.ts";

test("publisher tooling creates a release accepted by the runtime verifier", async () => {
  const directory = await extensionDirectory();
  try {
    const keys = await generatePublisherKey("Example GmbH", "example-2026");
    const release = await signExtensionRelease(
      directory,
      keys.privateKey,
      "example-2026",
    );
    await new Ed25519ExtensionReleaseVerifier(keys.trust.publishers).verify(
      directory,
      await readExtensionManifest(directory),
      release,
    );
    assertEquals(release.extensionId, "example.echo");
    assertEquals(release.publisher, "Example GmbH");
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

test("publisher tooling never accepts a public key for signing", async () => {
  const directory = await extensionDirectory();
  try {
    const keys = await generatePublisherKey("Example GmbH", "example-2026");
    await assertRejects(
      () =>
        signExtensionRelease(
          directory,
          keys.trust.publishers[0].publicKey,
          "example-2026",
        ),
      Error,
      "private JWK",
    );
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});

async function extensionDirectory(): Promise<string> {
  const directory = await makeTempDirectory();
  await fs.writeFile(
    `${directory}/extension-manifest.json`,
    JSON.stringify({
      schemaVersion: 2,
      id: "example.echo",
      displayName: "Echo",
      description: "Returns its input.",
      publisher: "Example GmbH",
      version: "1.0.0",
      runtime: { kind: "node-process", entrypoint: "main.ts" },
      capabilities: [],
      permissions: { network: [], configuredNetwork: [], secrets: [] },
      actions: [
        {
          name: "echo",
          idempotent: true,
          timeoutSeconds: 10,
        },
      ],
      translations: {},
    }),
  );
  await fs.writeFile(
    `${directory}/main.ts`,
    "export default { echo: (input: unknown) => input };\n",
  );
  return directory;
}
