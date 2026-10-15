import { test } from "node:test";
import { makeTempDirectory } from "../runtime/files.ts";
import * as fs from "node:fs/promises";
import { assertEquals, assertRejects } from "../test/assert.ts";
import {
  createProject,
  executeDevelopmentAction,
  packageProject,
  testProject,
  validateProject,
} from "./project.ts";
import { generatePublisherKey } from "../runtime/extension-publisher.ts";

test("scaffolded Hello World extension validates, tests, packages and executes", async () => {
  const root = await makeTempDirectory();
  const project = `${root}/hello-world`;
  try {
    await createProject({
      id: "hello-world",
      directory: project,
      displayName: "Hello World",
      publisher: "FLAMOX365",
      sdkSource: new URL("../sdk/mod.ts", import.meta.url).href,
    });
    const manifest = await validateProject(project);
    assertEquals(manifest.capabilities, ["host.ui.message-box"]);
    await fs.writeFile(
      `${project}/store-image.png`,
      Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        ),
        (character) => character.charCodeAt(0),
      ),
    );
    await testProject(project);

    const calls: unknown[] = [];
    assertEquals(
      await executeDevelopmentAction({
        directory: project,
        input: { title: "Hello", message: "World", kind: "info" },
        hostCapabilities: {
          invoke: (call) => {
            calls.push(call);
            return Promise.resolve({ displayed: true });
          },
        },
      }),
      { displayed: true },
    );
    assertEquals(calls.length, 1);

    const pair = await generatePublisherKey("FLAMOX365", "official-2026");
    const keyPath = `${root}/publisher.jwk`;
    await fs.writeFile(keyPath, JSON.stringify(pair.privateKey));
    const packaged = await packageProject(project, keyPath, "official-2026");
    assertEquals(packaged.bundle.release.extensionId, "hello-world");
    assertEquals(
      packaged.bundle.files.some(
        (file) => file.path === "runtime/extension.mjs",
      ),
      true,
    );
    assertEquals(
      packaged.bundle.files.some(
        (file) =>
          file.path.startsWith("src/") ||
          file.path.endsWith("/sdk.ts") ||
          file.path === "package.json" ||
          file.path === "yarn.lock",
      ),
      false,
    );
    assertEquals(
      packaged.bundle.files.some((file) => file.path.endsWith(".spec.ts")),
      false,
    );
    assertEquals(
      packaged.bundle.files.some((file) => file.path === "store-image.png"),
      true,
    );
    assertEquals(
      packaged.bundle.files.some(
        (file) =>
          file.path === "grant.dev.json" ||
          file.path.startsWith("examples/") ||
          /\.(?:jwk|pem|key)$/u.test(file.path),
      ),
      false,
    );
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test("project validation rejects ambiguous or invalid Store images", async () => {
  const root = await makeTempDirectory();
  const project = `${root}/store-image`;
  try {
    await createProject({
      id: "store-image",
      directory: project,
      displayName: "Store image",
      publisher: "FLAMOX365",
      sdkSource: new URL("../sdk/mod.ts", import.meta.url).href,
    });
    await fs.writeFile(`${project}/store-image.png`, "not a PNG");
    await assertRejects(
      () => validateProject(project),
      Error,
      "does not match its file type",
    );
    await fs.writeFile(`${project}/store-image.webp`, "not a WebP");
    await assertRejects(
      () => validateProject(project),
      Error,
      "only one Store image",
    );
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test("telephony scaffold is deployable and declares the optional Area contract", async () => {
  const root = await makeTempDirectory();
  const project = `${root}/telephony-provider`;
  try {
    await createProject({
      id: "telephony-provider",
      directory: project,
      displayName: "Telephony provider",
      publisher: "FLAMOX365",
      area: "telephony",
      sdkSource: new URL("../sdk/mod.ts", import.meta.url).href,
    });
    const manifest = await validateProject(project);
    assertEquals(manifest.contributions[0]?.area, "telephony");
    await testProject(project);
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test("project validation rejects oversized JSON Schema resources", async () => {
  const root = await makeTempDirectory();
  const project = `${root}/oversized-schema`;
  try {
    await createProject({
      id: "oversized-schema",
      directory: project,
      displayName: "Oversized schema",
      publisher: "FLAMOX365",
      sdkSource: new URL("../sdk/mod.ts", import.meta.url).href,
    });
    await fs.writeFile(
      `${project}/configuration.schema.json`,
      " ".repeat(256 * 1024 + 1),
    );
    await assertRejects(
      () => validateProject(project),
      Error,
      "cannot be read",
    );
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test("project tests execute in an independent Node runner and propagate a real assertion failure", async (t) => {
  const root = await makeTempDirectory();
  const project = `${root}/failing-tests`;
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await createProject({
    id: "failing-tests",
    directory: project,
    displayName: "Failing tests",
    publisher: "FLAMOX365",
    sdkSource: new URL("../sdk/mod.ts", import.meta.url).href,
  });
  await fs.writeFile(
    `${project}/src/main.spec.ts`,
    'import { test } from "node:test"; import assert from "node:assert/strict"; test("deliberate runtime regression", () => assert.equal(1, 2));',
  );
  await assertRejects(
    () => testProject(project),
    Error,
    "Extension tests failed with exit code 1",
  );
});
