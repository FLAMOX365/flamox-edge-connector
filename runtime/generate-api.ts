import { OpenApiGenerator } from "@goast/core";
import { TypeScriptModelsGenerator } from "@goast/typescript";
import { emptyDir } from "@std/fs/empty-dir";
import { resolve } from "@std/path";

const sourceDir = resolve(import.meta.dirname ?? Deno.cwd(), "../openapi");
const outputDir = resolve(import.meta.dirname ?? Deno.cwd(), "generated");

await emptyDir(outputDir);

await new OpenApiGenerator({ outputDir })
  .useType(TypeScriptModelsGenerator, {
    importModuleTransformer: "with-extension",
  })
  .parseAndGenerateFromDir(sourceDir);
