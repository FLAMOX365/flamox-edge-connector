import { walk } from "@std/fs";
import { dirname, isAbsolute, relative, resolve } from "@std/path";
import {
  computeExtensionDigest,
  type ExtensionReleaseDescriptor,
  parseExtensionReleaseDescriptor,
} from "./extension-integrity.ts";

export const EXTENSION_BUNDLE_MEDIA_TYPE =
  "application/vnd.flamox.edge-extension+json";
const maximumBundleFileBytes = 150 * 1024 * 1024;
const maximumPackageFiles = 1_000;
const maximumPackageFileBytes = 25 * 1024 * 1024;
const maximumPackageBytes = 100 * 1024 * 1024;

export type ExtensionBundleFile = {
  readonly path: string;
  readonly contentBase64: string;
};

export type ExtensionBundle = {
  readonly schemaVersion: 1;
  readonly mediaType: typeof EXTENSION_BUNDLE_MEDIA_TYPE;
  readonly release: ExtensionReleaseDescriptor;
  readonly files: readonly ExtensionBundleFile[];
};

/** Creates the single immutable artifact uploaded to the Extension Store. */
export async function createExtensionBundle(
  sourceDirectory: string,
  releaseValue: unknown,
): Promise<ExtensionBundle> {
  const source = await Deno.realPath(sourceDirectory);
  const release = parseExtensionReleaseDescriptor(releaseValue);
  const digest = await computeExtensionDigest(source);
  if (digest !== release.digest) {
    throw new Error("Extension release digest does not match package files.");
  }
  const files: ExtensionBundleFile[] = [];
  let totalBytes = 0;
  for await (
    const entry of walk(source, {
      includeDirs: false,
      includeSymlinks: true,
      followSymlinks: false,
    })
  ) {
    if (entry.isSymlink || !entry.isFile) {
      if (entry.isSymlink) {
        throw new Error("Extension bundles cannot contain symbolic links.");
      }
      continue;
    }
    if (files.length >= maximumPackageFiles) {
      throw new Error(`Extension bundle exceeds ${maximumPackageFiles} files.`);
    }
    const bytes = await Deno.readFile(entry.path);
    if (bytes.byteLength > maximumPackageFileBytes) {
      throw new Error(`Extension bundle file '${entry.path}' is too large.`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > maximumPackageBytes) {
      throw new Error(`Extension bundle exceeds ${maximumPackageBytes} bytes.`);
    }
    files.push({
      path: safeBundlePath(relative(source, entry.path)),
      contentBase64: encodeBase64(bytes),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: 1,
    mediaType: EXTENSION_BUNDLE_MEDIA_TYPE,
    release,
    files,
  };
}

export async function writeExtensionBundle(
  bundle: ExtensionBundle,
  path: string,
): Promise<void> {
  const parsed = parseExtensionBundle(bundle);
  await Deno.writeTextFile(path, `${JSON.stringify(parsed)}\n`, {
    create: true,
    mode: 0o600,
  });
}

export async function readExtensionBundle(
  path: string,
): Promise<ExtensionBundle> {
  const info = await Deno.stat(path);
  if (!info.isFile || info.size > maximumBundleFileBytes) {
    throw new Error("Extension bundle is missing or too large.");
  }
  return parseExtensionBundle(JSON.parse(await Deno.readTextFile(path)));
}

/** Extracts a validated bundle into a new staging directory. */
export async function extractExtensionBundle(
  bundleValue: unknown,
  targetDirectory: string,
): Promise<ExtensionBundle> {
  const bundle = parseExtensionBundle(bundleValue);
  await Deno.mkdir(targetDirectory, { recursive: false, mode: 0o700 });
  const targetRoot = resolve(targetDirectory);
  try {
    for (const file of bundle.files) {
      const destination = resolve(targetRoot, file.path);
      const relativeDestination = relative(targetRoot, destination).replaceAll(
        "\\",
        "/",
      );
      if (
        relativeDestination === ".." ||
        relativeDestination.startsWith("../") ||
        isAbsolute(relativeDestination)
      ) {
        throw new Error("Extension bundle path escapes its staging directory.");
      }
      const bytes = decodeBase64(file.contentBase64);
      await Deno.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await Deno.writeFile(destination, bytes, {
        createNew: true,
        mode: 0o600,
      });
    }
    if (await computeExtensionDigest(targetRoot) !== bundle.release.digest) {
      throw new Error(
        "Extracted extension bundle digest does not match release.",
      );
    }
    return bundle;
  } catch (error) {
    await Deno.remove(targetRoot, { recursive: true }).catch(() => undefined);
    throw error;
  }
}

export function parseExtensionBundle(value: unknown): ExtensionBundle {
  if (!isRecord(value)) invalid();
  exactKeys(value, ["schemaVersion", "mediaType", "release", "files"]);
  if (
    value.schemaVersion !== 1 ||
    value.mediaType !== EXTENSION_BUNDLE_MEDIA_TYPE ||
    !Array.isArray(value.files) || value.files.length === 0 ||
    value.files.length > maximumPackageFiles
  ) invalid();
  const paths = new Set<string>();
  let totalBytes = 0;
  const files = value.files.map((nested) => {
    if (!isRecord(nested)) invalid();
    exactKeys(nested, ["path", "contentBase64"]);
    const path = safeBundlePath(nested.path);
    if (paths.has(path)) {
      throw new Error(`Extension bundle path '${path}' is duplicated.`);
    }
    paths.add(path);
    if (typeof nested.contentBase64 !== "string") invalid();
    const bytes = decodeBase64(nested.contentBase64);
    if (bytes.byteLength > maximumPackageFileBytes) invalid();
    totalBytes += bytes.byteLength;
    if (totalBytes > maximumPackageBytes) invalid();
    return { path, contentBase64: nested.contentBase64 };
  });
  return {
    schemaVersion: 1,
    mediaType: EXTENSION_BUNDLE_MEDIA_TYPE,
    release: parseExtensionReleaseDescriptor(value.release),
    files,
  };
}

function safeBundlePath(value: unknown): string {
  if (typeof value !== "string") invalid();
  const path = value.replaceAll("\\", "/");
  if (
    path.length === 0 || path.length > 500 || path.startsWith("/") ||
    path.split("/").some((segment) =>
      segment === "" || segment === ".." || segment === "."
    )
  ) invalid();
  return path;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch (error) {
    throw new Error("Extension bundle file content is not valid base64.", {
      cause: error,
    });
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) invalid();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new Error("Extension bundle is invalid.");
}
