import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { isFunctionsPath } from "./function-watcher.ts";

Deno.test("isFunctionsPath matches the functions directory and nested files only", () => {
  const root = join(Deno.cwd(), "functions");

  assertEquals(isFunctionsPath(root, root), true);
  assertEquals(isFunctionsPath(root, join(root, "index.ts")), true);
  assertEquals(isFunctionsPath(root, join(root, "users", "index.yml")), true);
  assertEquals(
    isFunctionsPath(root, join(Deno.cwd(), "functionality.ts")),
    false,
  );
});
