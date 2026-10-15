import { test } from "node:test";
import { writeFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { makeTempDirectory } from "./files.ts";
import { executeCommand } from "./command.ts";
import { assertEquals } from "../test/assert.ts";

test("compiled Node service loads standalone ESM Functions with full TypeScript syntax", async () => {
  const directory = await makeTempDirectory("edge-ts-function-");
  const functionPath = `${directory}/health.ts`;
  await writeFile(
    functionPath,
    'enum Status { Ready = 200 }\nclass Greeting { constructor(private readonly text: string) {} value() { return this.text; } }\nexport function GET() { return new Response(new Greeting("ready").value(), { status: Status.Ready }); }\n',
  );
  try {
    const loader = new URL(
      "../dist/runtime/function-loader.js",
      import.meta.url,
    ).href;
    const script = `import { importFunction } from ${JSON.stringify(loader)}; const handler = await importFunction(${JSON.stringify(pathToFileURL(functionPath).href)}); const response = handler.GET(); console.log(JSON.stringify({ status: response.status, body: await response.text() }));`;
    const result = await executeCommand(process.execPath, [
      "--input-type=module",
      "--eval",
      script,
    ]);
    assertEquals(result.success, true, new TextDecoder().decode(result.stderr));
    assertEquals(JSON.parse(new TextDecoder().decode(result.stdout)), {
      status: 200,
      body: "ready",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
