import { test } from "node:test";
import { makeTempDirectory } from "./files.ts";
import * as fs from "node:fs/promises";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "../test/assert.ts";
import { generateApiModels } from "./generate-api.ts";

test("generates deterministic models without an external generator", async () => {
  const root = await makeTempDirectory();
  const source = `${root}/openapi`;
  const output = `${root}/generated`;
  try {
    await fs.mkdir(source);
    await fs.writeFile(
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
      await fs.readFile(`${output}/models/event-kind.ts`, "utf8"),
      `// Generated from OpenAPI schemas. Do not edit manually.

export const EVENT_KIND_VALUES = [
  "created",
  "deleted"
] as const;

export type EventKind = (typeof EVENT_KIND_VALUES)[number];
`,
    );
    assertStringIncludes(
      await fs.readFile(`${output}/models/event.ts`, "utf8"),
      'import type { EventKind } from "./event-kind.ts";',
    );
    assertStringIncludes(
      await fs.readFile(`${output}/models/event.ts`, "utf8"),
      "payload?: (string) | null;",
    );
    assertStringIncludes(
      await fs.readFile(`${output}/models/frame.ts`, "utf8"),
      "export type Frame<",
    );
    assertStringIncludes(
      await fs.readFile(`${output}/models/frame.ts`, "utf8"),
      '"event": { kind: "event" } & EventFrame;',
    );
    assertStringIncludes(
      await fs.readFile(`${output}/models/event-frame.ts`, "utf8"),
      'import type { _FrameBase } from "./frame.ts";',
    );
    assertStringIncludes(
      await fs.readFile(`${output}/models.ts`, "utf8"),
      'export { EVENT_KIND_VALUES } from "./models/event-kind.ts";',
    );
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test("rejects duplicate component schemas", async () => {
  const root = await makeTempDirectory();
  const source = `${root}/openapi`;
  try {
    await fs.mkdir(source);
    const document = `components:
  schemas:
    Duplicate:
      type: string
`;
    await fs.writeFile(`${source}/first.yml`, document);
    await fs.writeFile(`${source}/second.yml`, document);

    await assertRejects(
      () => generateApiModels(source, `${root}/generated`),
      Error,
      "Duplicate OpenAPI component schema 'Duplicate'",
    );
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test("rejects unsafe component schema names before replacing output", async () => {
  const root = await makeTempDirectory();
  const source = `${root}/openapi`;
  const output = `${root}/generated`;
  try {
    await fs.mkdir(source);
    await fs.mkdir(output);
    await fs.writeFile(`${output}/sentinel.ts`, "preserved\n");
    await fs.writeFile(
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
      await fs.readFile(`${output}/sentinel.ts`, "utf8"),
      "preserved\n",
    );
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
