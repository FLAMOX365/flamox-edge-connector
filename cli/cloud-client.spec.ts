import { test } from "node:test";
import { makeTempDirectory } from "../runtime/files.ts";
import * as fs from "node:fs/promises";
import { assertEquals } from "../test/assert.ts";
import { createExtensionBundle } from "../runtime/extension-bundle.ts";
import {
  generatePublisherKey,
  signExtensionRelease,
} from "../runtime/extension-publisher.ts";
import { CloudClient } from "./cloud-client.ts";

test("CloudClient registers trust before atomically importing the signed FMX bundle", async () => {
  const directory = await makeTempDirectory();
  try {
    await fs.writeFile(
      `${directory}/extension-manifest.json`,
      JSON.stringify({
        schemaVersion: 2,
        id: "hello-world",
        displayName: "Hello World",
        description: "Test extension.",
        publisher: "FLAMOX365",
        version: "0.1.0",
        runtime: { kind: "node-process", entrypoint: "main.ts" },
        capabilities: [],
        permissions: { network: [], secrets: [] },
        actions: [
          {
            name: "hello",
            idempotent: true,
            timeoutSeconds: 5,
          },
        ],
      }),
    );
    await fs.writeFile(
      `${directory}/main.ts`,
      "export default { actions: { hello: () => 'hello' } };\n",
    );
    const pair = await generatePublisherKey("FLAMOX365", "official");
    const release = await signExtensionRelease(
      directory,
      pair.privateKey,
      "official",
    );
    const bundle = await createExtensionBundle(directory, release);
    const requests: Request[] = [];
    const responses = [
      { keyId: "official", publisher: "FLAMOX365", active: true },
      {
        id: "release-1",
        version: "0.1.0",
        status: "DRAFT",
      },
    ];
    const client = new CloudClient(
      "https://cloud.example",
      "secret-token",
      "system",
      (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(
          Response.json({
            success: true,
            status: 200,
            timestamp: new Date().toISOString(),
            data: responses.shift(),
          }),
        );
      },
    );
    assertEquals(await client.publish(bundle, pair.trust.publishers[0]!), {
      extensionId: "hello-world",
      version: "0.1.0",
      status: "DRAFT",
      releaseId: "release-1",
    });
    assertEquals(
      requests.map((request) => new URL(request.url).pathname),
      [
        "/api/v1/system/edge/store/publishers",
        "/api/v1/system/edge/store/releases",
      ],
    );
    assertEquals(
      requests.every(
        (request) =>
          request.headers.get("authorization") === "Bearer secret-token",
      ),
      true,
    );
    assertEquals(requests[1]?.body instanceof ReadableStream, true);
    assertEquals(
      requests[0]?.headers.get("authorization"),
      "Bearer secret-token",
    );
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});
