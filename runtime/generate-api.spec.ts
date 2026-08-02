import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { generateApiModels } from "./generate-api.ts";

Deno.test("generates deterministic models without an external generator", async () => {
  const root = await Deno.makeTempDir();
  const source = `${root}/openapi`;
  const output = `${root}/generated`;
  try {
    await Deno.mkdir(source);
    await Deno.writeTextFile(
      `${source}/api.yml`,
      `components:
  schemas:
    EventKind:
      type: string
      enum: [created, deleted]
    Event:
      type: object
      properties:
        kind:
          $ref: "#/components/schemas/EventKind"
        payload:
          type: string
          nullable: true
      required: [kind]
    Frame:
      type: object
      properties:
        kind:
          type: string
      required: [kind]
      discriminator:
        propertyName: kind
        mapping:
          event: "#/components/schemas/EventFrame"
    EventFrame:
      allOf:
        - $ref: "#/components/schemas/Frame"
        - type: object
          properties:
            kind:
              type: string
              enum: [event]
            event:
              $ref: "#/components/schemas/Event"
          required: [kind, event]
`,
    );

    await generateApiModels(source, output);

    assertEquals(
      await Deno.readTextFile(`${output}/models/event-kind.ts`),
      `// Generated from OpenAPI schemas. Do not edit manually.

export const EVENT_KIND_VALUES = [
  "created",
  "deleted"
] as const;

export type EventKind = (typeof EVENT_KIND_VALUES)[number];
`,
    );
    assertStringIncludes(
      await Deno.readTextFile(`${output}/models/event.ts`),
      'import type { EventKind } from "./event-kind.ts";',
    );
    assertStringIncludes(
      await Deno.readTextFile(`${output}/models/event.ts`),
      "payload?: (string) | null;",
    );
    assertStringIncludes(
      await Deno.readTextFile(`${output}/models/frame.ts`),
      "export type Frame<",
    );
    assertStringIncludes(
      await Deno.readTextFile(`${output}/models/frame.ts`),
      '"event": { kind: "event" } & EventFrame;',
    );
    assertStringIncludes(
      await Deno.readTextFile(`${output}/models/event-frame.ts`),
      'import type { _FrameBase } from "./frame.ts";',
    );
    assertStringIncludes(
      await Deno.readTextFile(`${output}/models.ts`),
      'export { EVENT_KIND_VALUES } from "./models/event-kind.ts";',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rejects duplicate component schemas", async () => {
  const root = await Deno.makeTempDir();
  const source = `${root}/openapi`;
  try {
    await Deno.mkdir(source);
    const document = `components:
  schemas:
    Duplicate:
      type: string
`;
    await Deno.writeTextFile(`${source}/first.yml`, document);
    await Deno.writeTextFile(`${source}/second.yml`, document);

    await assertRejects(
      () => generateApiModels(source, `${root}/generated`),
      Error,
      "Duplicate OpenAPI component schema 'Duplicate'",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rejects unsafe component schema names before replacing output", async () => {
  const root = await Deno.makeTempDir();
  const source = `${root}/openapi`;
  const output = `${root}/generated`;
  try {
    await Deno.mkdir(source);
    await Deno.mkdir(output);
    await Deno.writeTextFile(`${output}/sentinel.ts`, "preserved\n");
    await Deno.writeTextFile(
      `${source}/api.yml`,
      `components:
  schemas:
    ../Outside:
      type: string
`,
    );

    await assertRejects(
      () => generateApiModels(source, output),
      Error,
      "is not a safe TypeScript identifier",
    );
    assertEquals(
      await Deno.readTextFile(`${output}/sentinel.ts`),
      "preserved\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
