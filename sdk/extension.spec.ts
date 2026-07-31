import { assertEquals } from "@std/assert";
import { defineExtension, isExtensionDefinition } from "./extension.ts";

Deno.test("defineExtension preserves valid isolated action definitions", async () => {
  const extension = defineExtension({
    actions: {
      status: (_context, input) => Promise.resolve({ input }),
    },
  });

  assertEquals(isExtensionDefinition(extension), true);
  assertEquals(
    await extension.actions.status(
      {
        requestId: "request-1",
        configuration: {},
        secrets: {},
        host: {
          ui: {
            showMessage: () => Promise.resolve({ displayed: true }),
          },
        },
      },
      "ok",
    ),
    { input: "ok" },
  );
});

Deno.test("isExtensionDefinition rejects malformed action exports", () => {
  assertEquals(isExtensionDefinition(null), false);
  assertEquals(isExtensionDefinition({}), false);
  assertEquals(
    isExtensionDefinition({ actions: { status: "invalid" } }),
    false,
  );
});
