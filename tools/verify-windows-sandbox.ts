import {
  SandboxManager,
  VENDORED_SRT_WIN_EXE,
} from "@anthropic-ai/sandbox-runtime";
import { realpath } from "node:fs/promises";
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

// Keep the same drive denials held throughout the suite. Each extension still
// starts its own SRT session with only its code grants and its own proxy.
console.log("Preparing drive ACLs for the Windows sandbox account.");
try {
  await SandboxManager.initialize({
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowLocalBinding: false,
      allowUnixSockets: [],
    },
    filesystem: {
      denyRead: roots.map((path) => ({ path, literal: true })),
      allowRead: [],
      allowWrite: [],
      denyWrite: [],
    },
    windows: { srtWin: { path: VENDORED_SRT_WIN_EXE } },
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
  await SandboxManager.reset();
}
