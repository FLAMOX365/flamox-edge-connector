import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Metafile } from "esbuild";

/** Carries the actual bundled dependencies' redistribution notices into FMX. */
export async function writeBundleLicenses(
  root: string,
  output: string,
  graph: Metafile,
  noticePath?: string | null,
): Promise<void> {
  const packages = new Map<string, string>();
  const inspected = new Set<string>();
  const declared = noticePath
    ? await readFile(join(root, noticePath), "utf8")
    : "";
  for (const input of Object.keys(graph.inputs)) {
    let directory = dirname(resolve(root, input));
    while (!inspected.has(directory)) {
      inspected.add(directory);
      let metadata:
        | {
            name?: string;
            version?: string;
            private?: boolean;
            license?: unknown;
          }
        | undefined;
      try {
        metadata = JSON.parse(
          await readFile(join(directory, "package.json"), "utf8"),
        );
      } catch {
        /* Walk to the package owning this source. */
      }
      if (metadata) {
        if (
          metadata.name &&
          metadata.version &&
          !metadata.private &&
          typeof metadata.license === "string"
        ) {
          const key = `${metadata.name}@${metadata.version}`;
          const files = (
            await readdir(directory, { withFileTypes: true })
          ).filter(
            (file) =>
              file.isFile() &&
              /^(?:licen[cs]e|copying|notice)(?:\.[^.]+)?$/iu.test(file.name),
          );
          const texts = await Promise.all(
            files
              .sort((left, right) => left.name.localeCompare(right.name))
              .map((file) => readFile(join(directory, file.name), "utf8")),
          );
          if (!texts.length && !declared.includes(metadata.name))
            throw new Error(
              `Bundled dependency '${key}' has no license text; add its upstream notice to the manifest's notices file.`,
            );
          packages.set(
            key,
            `## ${key} (${metadata.license})\n\n${texts.length ? texts.join("\n\n") : "Full license text is included in the package's declared notices file."}`,
          );
        }
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  if (packages.size)
    await writeFile(
      output,
      `# Bundled dependency licenses\n\n${[...packages]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, text]) => text)
        .join("\n\n")}\n`,
      { mode: 0o600 },
    );
}
