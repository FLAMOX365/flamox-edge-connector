import { cp, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function makeTempDirectory(prefix = "edge-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function emptyDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await Promise.all(
    (await readdir(directory)).map((name) =>
      rm(join(directory, name), { recursive: true, force: true }),
    ),
  );
}

export function copyTree(
  source: string,
  destination: string,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  return cp(source, destination, {
    recursive: true,
    dereference: false,
    force: options.overwrite ?? false,
    errorOnExist: !(options.overwrite ?? false),
  });
}

export type FileEntry = {
  readonly path: string;
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

export async function* walk(
  directory: string,
  options: {
    includeDirs?: boolean;
    includeFiles?: boolean;
    followSymlinks?: boolean;
    includeSymlinks?: boolean;
    skip?: readonly RegExp[];
  } = {},
): AsyncGenerator<FileEntry> {
  if (options.skip?.some((pattern) => pattern.test(directory))) return;
  const info = await lstat(directory);
  if (info.isSymbolicLink() && options.includeSymlinks === false) return;
  if (
    (info.isDirectory() && options.includeDirs !== false) ||
    (info.isFile() && options.includeFiles !== false) ||
    info.isSymbolicLink()
  ) {
    yield {
      path: directory,
      name: basename(directory),
      isFile: () => info.isFile(),
      isDirectory: () => info.isDirectory(),
      isSymbolicLink: () => info.isSymbolicLink(),
    };
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink())
      yield* walk(path, options);
    else if (
      options.includeFiles !== false &&
      !(entry.isSymbolicLink() && options.includeSymlinks === false) &&
      !options.skip?.some((pattern) => pattern.test(path))
    )
      yield {
        path,
        name: entry.name,
        isFile: () => entry.isFile(),
        isDirectory: () => entry.isDirectory(),
        isSymbolicLink: () => entry.isSymbolicLink(),
      };
  }
}
