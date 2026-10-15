import { test } from "node:test";
import { makeTempDirectory } from "../runtime/files.ts";
import * as fs from "node:fs/promises";
import { assertEquals, assertRejects } from "../test/assert.ts";
import { CliConfigStore, defaultCliDirectory } from "./config.ts";

test("defaultCliDirectory supports an isolated override", () => {
  assertEquals(
    defaultCliDirectory({ EDGE_EXTENSION_CLI_HOME: "/tmp/edge-cli" }),
    "/tmp/edge-cli",
  );
});

test("CliConfigStore creates one protected publisher identity", async () => {
  const directory = await makeTempDirectory();
  const store = new CliConfigStore(directory);
  try {
    const config = await store.initializePublisher(
      "FLAMOX365",
      "official-2026",
    );
    assertEquals(config.publisher?.name, "FLAMOX365");
    assertEquals(
      JSON.parse(await fs.readFile(config.publisher!.trustPath, "utf8"))
        .publishers[0].publisher,
      "FLAMOX365",
    );
    await assertRejects(
      () => store.initializePublisher("FLAMOX365", "other"),
      Error,
      "already exists",
    );
  } finally {
    await fs.rm(directory, { recursive: true });
  }
});
