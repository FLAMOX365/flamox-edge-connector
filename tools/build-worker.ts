import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: [
    fileURLToPath(new URL("../runtime/extension-process.ts", import.meta.url)),
  ],
  outfile: fileURLToPath(
    new URL("../dist/runtime/extension-process.mjs", import.meta.url),
  ),
  platform: "node",
  target: "node26",
  format: "esm",
  bundle: true,
  sourcemap: false,
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
