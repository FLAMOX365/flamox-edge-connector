import { test } from "node:test";
import { assertEquals } from "../test/assert.ts";
import { join } from "node:path";
import { isFunctionsPath } from "./function-watcher.ts";

test("isFunctionsPath matches the functions directory and nested files only", () => {
  const root = join(process.cwd(), "functions");

  assertEquals(isFunctionsPath(root, root), true);
  assertEquals(isFunctionsPath(root, join(root, "index.ts")), true);
  assertEquals(isFunctionsPath(root, join(root, "users", "index.yml")), true);
  assertEquals(
    isFunctionsPath(root, join(process.cwd(), "functionality.ts")),
    false,
  );
});
