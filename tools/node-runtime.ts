import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
  access,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { executeCommand } from "../runtime/command.ts";

/** Packages the official standalone runtime, never a locally linked Homebrew binary. */
export async function desktopNode(root: string): Promise<string> {
  const version = (await readFile(join(root, ".node-version"), "utf8")).trim();
  if (!/^26\.\d+\.\d+$/u.test(version))
    throw new Error("Invalid pinned Node.js version.");
  const platform = process.platform;
  const architecture = process.arch;
  if (
    !["darwin", "linux", "win32"].includes(platform) ||
    !["arm64", "x64"].includes(architecture)
  )
    throw new Error("Unsupported desktop runtime target.");
  const distribution = `node-v${version}-${platform === "win32" ? "win" : platform}-${architecture}`;
  const cache = join(homedir(), ".cache", "edge-connector-runtime");
  const binary = join(
    cache,
    distribution,
    platform === "win32" ? "node.exe" : "bin/node",
  );
  try {
    await access(binary);
  } catch {
    await mkdir(cache, { recursive: true });
    const archive = `${distribution}${platform === "win32" ? ".zip" : ".tar.gz"}`;
    const base = `https://nodejs.org/dist/v${version}/`;
    const [download, sums] = await Promise.all([
      fetch(`${base}${archive}`),
      fetch(`${base}SHASUMS256.txt`),
    ]);
    if (!download.ok || !sums.ok)
      throw new Error(
        "Could not download the pinned official Node.js runtime.",
      );
    const bytes = new Uint8Array(await download.arrayBuffer());
    const expected = (await sums.text())
      .split("\n")
      .map((line) => line.trim().split(/\s+/u))
      .find((parts) => parts[1] === archive)?.[0];
    if (
      !expected ||
      createHash("sha256").update(bytes).digest("hex") !== expected
    )
      throw new Error("Node.js archive checksum verification failed.");
    const staging = join(cache, `download-${crypto.randomUUID()}`);
    await mkdir(staging);
    try {
      const path = join(staging, archive);
      await writeFile(path, bytes);
      const unpack =
        platform === "win32"
          ? await executeCommand("tar.exe", ["-xf", path, "-C", staging])
          : await executeCommand("tar", ["-xzf", path, "-C", staging]);
      if (!unpack.success)
        throw new Error("Could not extract the Node.js runtime.");
      await rename(join(staging, distribution), join(cache, distribution));
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  const installed = await executeCommand(binary, ["--version"]);
  if (
    !installed.success ||
    new TextDecoder().decode(installed.stdout).trim() !== `v${version}`
  )
    throw new Error("The cached Node.js runtime does not match .node-version.");
  if (platform !== "win32") await chmod(binary, 0o755);
  return binary;
}
