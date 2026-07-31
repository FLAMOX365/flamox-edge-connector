import { assertEquals } from "@std/assert";
import { RuntimeError, toEdgeConnectorError } from "./runtime-error.ts";

Deno.test("toEdgeConnectorError preserves RuntimeError codes", () => {
  assertEquals(
    toEdgeConnectorError(new RuntimeError("HOOK_REJECTED", "Rejected")),
    { code: "HOOK_REJECTED", message: "Rejected" },
  );
});

Deno.test("toEdgeConnectorError hides unexpected internal details", () => {
  assertEquals(toEdgeConnectorError(new Error("Boom")), {
    code: "UNEXPECTED_ERROR",
    message: "Unexpected connector error.",
  });
  assertEquals(toEdgeConnectorError("plain failure"), {
    code: "UNEXPECTED_ERROR",
    message: "Unexpected connector error.",
  });
});
