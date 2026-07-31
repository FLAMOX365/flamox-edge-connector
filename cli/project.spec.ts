import { assertEquals, assertRejects } from "@std/assert";
import {
  createProject,
  executeDevelopmentAction,
  packageProject,
  testProject,
  validateProject,
} from "./project.ts";
import { generatePublisherKey } from "../runtime/extension-publisher.ts";

Deno.test("scaffolded Hello World extension validates, tests, packages and executes", async () => {
  const root = await Deno.makeTempDir();
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
    await Deno.writeTextFile(keyPath, JSON.stringify(pair.privateKey));
    const packaged = await packageProject(
      project,
      keyPath,
      "official-2026",
    );
    assertEquals(packaged.bundle.release.extensionId, "hello-world");
    assertEquals(
      packaged.bundle.files.some((file) =>
        file.path === "runtime/extension.js"
      ),
      true,
    );
    assertEquals(
      packaged.bundle.files.some((file) =>
        file.path.startsWith("src/") || file.path.endsWith("/sdk.ts") ||
        file.path === "deno.json" || file.path === "deno.lock"
      ),
      false,
    );
    assertEquals(
      packaged.bundle.files.some((file) => file.path.endsWith(".spec.ts")),
      false,
    );
    assertEquals(
      packaged.bundle.files.some((file) =>
        file.path === "grant.dev.json" ||
        file.path.startsWith("examples/") ||
        /\.(?:jwk|pem|key)$/u.test(file.path)
      ),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("telephony scaffold is deployable and declares the optional Area contract", async () => {
  const root = await Deno.makeTempDir();
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
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("project validation rejects oversized JSON Schema resources", async () => {
  const root = await Deno.makeTempDir();
  const project = `${root}/oversized-schema`;
  try {
    await createProject({
      id: "oversized-schema",
      directory: project,
      displayName: "Oversized schema",
      publisher: "FLAMOX365",
      sdkSource: new URL("../sdk/mod.ts", import.meta.url).href,
    });
    await Deno.writeTextFile(
      `${project}/configuration.schema.json`,
      " ".repeat(256 * 1024 + 1),
    );
    await assertRejects(
      () => validateProject(project),
      Error,
      "cannot be read",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
