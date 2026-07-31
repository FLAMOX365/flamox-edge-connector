import { assertEquals, assertRejects } from "@std/assert";
import { CliConfigStore, defaultCliDirectory } from "./config.ts";

Deno.test("defaultCliDirectory supports an isolated override", () => {
  assertEquals(
    defaultCliDirectory({ EDGE_EXTENSION_CLI_HOME: "/tmp/edge-cli" }),
    "/tmp/edge-cli",
  );
});

Deno.test("CliConfigStore creates one protected publisher identity", async () => {
  const directory = await Deno.makeTempDir();
  const store = new CliConfigStore(directory);
  try {
    const config = await store.initializePublisher(
      "FLAMOX365",
      "official-2026",
    );
    assertEquals(config.publisher?.name, "FLAMOX365");
    assertEquals(
      JSON.parse(await Deno.readTextFile(config.publisher!.trustPath))
        .publishers[0].publisher,
      "FLAMOX365",
    );
    await assertRejects(
      () => store.initializePublisher("FLAMOX365", "other"),
      Error,
      "already exists",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
