import { registerHooks } from "node:module";
import { transformSync } from "esbuild";

let registered = false;

/** Retains the operator Functions contract: local TypeScript modules are ESM. */
export async function importFunction(url: string): Promise<unknown> {
  if (!registered) {
    registerHooks({
      load(specifier, context, nextLoad) {
        const pathname = new URL(specifier).pathname;
        if (
          specifier.startsWith("file:") &&
          /\.(?:ts|mts)$/u.test(pathname) &&
          !pathname.endsWith(".d.ts")
        ) {
          const loaded = nextLoad(specifier, {
            ...context,
            format: "module-typescript",
          });
          if (loaded.source === null || loaded.source === undefined)
            throw new Error("Function source is unavailable.");
          const source =
            typeof loaded.source === "string"
              ? loaded.source
              : new TextDecoder().decode(loaded.source);
          return {
            ...loaded,
            format: "module",
            source: transformSync(source, {
              loader: "ts",
              format: "esm",
              target: "node26",
              sourcefile: specifier,
              sourcemap: "inline",
            }).code,
          };
        }
        return nextLoad(specifier, context);
      },
    });
    registered = true;
  }
  return import(url);
}
