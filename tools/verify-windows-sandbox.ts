import {
  SandboxManager,
  VENDORED_SRT_WIN_EXE,
} from "@anthropic-ai/sandbox-runtime";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommand } from "../runtime/command.ts";
import { windowsReadRoots } from "../runtime/windows-sandbox-roots.ts";

const corepack = process.env["COREPACK_ROOT"];
if (process.platform !== "win32" || !corepack) {
  throw new Error(
    "Run the Windows sandbox verification through Corepack Yarn.",
  );
}
const directory = await realpath(process.cwd());
const roots = await windowsReadRoots(directory);
const broker = await realpath(VENDORED_SRT_WIN_EXE);
const probeDirectory = await realpath(
  await mkdtemp(join(tmpdir(), "edge-sandbox-verify-")),
);

// Keep the same drive denials held throughout the suite. Each extension still
// starts its own SRT session with only its code grants and its own proxy.
console.log("Preparing drive ACLs for the Windows sandbox account.");
try {
  process.chdir(probeDirectory);
  await SandboxManager.initialize({
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowLocalBinding: false,
      allowUnixSockets: [],
    },
    filesystem: {
      denyRead: roots.map((path) => ({ path, literal: true })),
      allowRead: [broker, probeDirectory].map((path) => ({
        path,
        literal: true,
      })),
      allowWrite: [],
      denyWrite: [],
    },
    windows: { srtWin: { path: broker } },
  });
  if (SandboxManager.getWindowsProfileRead() !== "absent") {
    throw new Error(
      "The Windows extension sandbox requires profile access to be disabled.",
    );
  }
  console.log("Drive ACLs ready. Running the full Windows coverage suite.");
  const result = await executeCommand(
    process.execPath,
    [join(corepack, "dist", "yarn.js"), "test:coverage"],
    { cwd: directory, inherit: true },
  );
  process.exitCode = result.code;
} finally {
  try {
    await SandboxManager.reset();
  } finally {
    process.chdir(directory);
    await rm(probeDirectory, { recursive: true, force: true });
  }
}
