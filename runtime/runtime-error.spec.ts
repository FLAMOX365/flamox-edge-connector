import { test } from "node:test";
import { assertEquals } from "../test/assert.ts";
import { RuntimeError, toEdgeConnectorError } from "./runtime-error.ts";

test("toEdgeConnectorError preserves RuntimeError codes", () => {
  assertEquals(
    toEdgeConnectorError(new RuntimeError("HOOK_REJECTED", "Rejected")),
    { code: "HOOK_REJECTED", message: "Rejected" },
  );
});

test("toEdgeConnectorError hides unexpected internal details", () => {
  assertEquals(toEdgeConnectorError(new Error("Boom")), {
    code: "UNEXPECTED_ERROR",
    message: "Unexpected connector error.",
  });
  assertEquals(toEdgeConnectorError("plain failure"), {
    code: "UNEXPECTED_ERROR",
    message: "Unexpected connector error.",
  });
});
