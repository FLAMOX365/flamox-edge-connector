import { test } from "node:test";
import { makeTempDirectory } from "../runtime/files.ts";
import * as fs from "node:fs/promises";
import { assertEquals } from "../test/assert.ts";
import { CliConfigStore } from "./config.ts";
import { runCli } from "./main.ts";

test("init creates a tested and signed deployable extension without manual file work", async () => {
  const root = await makeTempDirectory();
  const project = `${root}/ready-extension`;
  const store = new CliConfigStore(`${root}/cli`);
  try {
    await runCli(
      [
        "init",
        project,
        "--yes",
        "--id",
        "ready-extension",
        "--name",
        "Ready Extension",
        "--description",
        "A complete generated extension.",
        "--publisher",
        "FLAMOX365",
        "--version",
        "1.0.0",
        "--key-id",
        "official-2026",
        "--sdk-source",
        new URL("../sdk/mod.ts", import.meta.url).href,
      ],
      store,
      () => {
        throw new Error("Non-interactive initialization must not prompt.");
      },
    );

    const manifest = JSON.parse(
      await fs.readFile(`${project}/extension-manifest.json`, "utf8"),
    );
    assertEquals(manifest.id, "ready-extension");
    assertEquals(manifest.version, "1.0.0");
    assertEquals(manifest.configurationSchema, "configuration.schema.json");
    const artifact = `${project}/.edge/releases/ready-extension-1.0.0.fmx`;
    assertEquals((await fs.stat(artifact)).isFile(), true);
    assertEquals((await store.load()).publisher?.keyId, "official-2026");
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
