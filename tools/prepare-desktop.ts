import { build } from "esbuild";
import { cp, copyFile, mkdir, readFile, rm, chmod } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { executeCommand } from "../runtime/command.ts";
import { desktopNode } from "./node-runtime.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
if (Number(process.versions.node.split(".")[0]) !== 26)
  throw new Error("Desktop packaging requires Node.js 26.");
const resources = join(root, "desktop/resources/connector");
await rm(resources, { recursive: true, force: true });
await mkdir(resources, { recursive: true });
await cp(join(root, "dist"), join(resources, "dist"), { recursive: true });
await copyFile(join(root, "package.json"), join(resources, "package.json"));
const installed = new Map<string, string>();
const manifest = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
) as { dependencies: Record<string, string> };
for (const name of Object.keys(manifest.dependencies))
  await copyDependency(name, root, resources);

const rustc =
  process.platform === "win32"
    ? join(homedir(), ".cargo/bin/rustc.exe")
    : join(homedir(), ".cargo/bin/rustc");
const compiler = await executeCommand(rustc, ["-vV"]);
if (!compiler.success)
  throw new Error("The Rust target could not be determined.");
const target = new TextDecoder()
  .decode(compiler.stdout)
  .match(/^host: (.+)$/mu)?.[1];
if (!target) throw new Error("The Rust target could not be determined.");
const binaries = join(root, "desktop/src-tauri/binaries");
await mkdir(binaries, { recursive: true });
const binary = join(
  binaries,
  `node-${target}${process.platform === "win32" ? ".exe" : ""}`,
);
const runtime = await desktopNode(root);
await copyFile(runtime, binary);
const distribution =
  process.platform === "win32" ? dirname(runtime) : dirname(dirname(runtime));
await copyFile(
  join(distribution, "LICENSE"),
  join(resources, "NODE-LICENSE.txt"),
);
await chmod(binary, 0o755);
await build({
  entryPoints: [join(root, "desktop/bridge.ts")],
  outfile: join(root, "desktop/ui/bridge.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
});

async function copyDependency(
  name: string,
  from: string,
  destination: string,
): Promise<void> {
  const source = await packageDirectory(name, from);
  let target = join(resources, "node_modules", name);
  const previous = installed.get(target);
  if (previous && previous !== source)
    target = join(destination, "node_modules", name);
  if (installed.get(target) === source) return;
  installed.set(target, source);
  await cp(source, target, {
    recursive: true,
    dereference: true,
    filter: (file) =>
      !relative(source, file)
        .split(sep)
        .some(
          (part) =>
            part === "node_modules" ||
            part === ".git" ||
            part.endsWith(".spec.ts"),
        ),
  });
  const dependency = JSON.parse(
    await readFile(join(source, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  for (const nested of Object.keys(dependency.dependencies ?? {}))
    await copyDependency(nested, source, target);
  for (const nested of new Set([
    ...Object.keys(dependency.optionalDependencies ?? {}),
    ...Object.keys(dependency.peerDependencies ?? {}),
  ])) {
    try {
      await packageDirectory(nested, source);
    } catch {
      continue;
    }
    await copyDependency(nested, source, target);
  }
}

async function packageDirectory(name: string, from: string): Promise<string> {
  const require = createRequire(join(from, "package.json"));
  for (const search of require.resolve.paths(name) ?? []) {
    const directory = join(search, name);
    try {
      const value = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      ) as { name?: string };
      if (value.name === name) return directory;
    } catch {
      /* Continue through Node's module search paths. */
    }
  }
  throw new Error(`Cannot package dependency '${name}'.`);
}
