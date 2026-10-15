import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { spawn, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { parse, join } from "node:path";
import { executeCommand } from "./command.ts";
import type {
  ExtensionInboundMessage,
  ExtensionOutboundMessage,
} from "./extension-messages.ts";

/** One privileged supervisor per extension: proxy policy is never shared. */
type SandboxStart = {
  readonly type: "sandbox-start";
  readonly extensionDirectory: string;
  readonly network: readonly string[];
  readonly workerPath: string;
};

const maximumMessageBytes = 16 * 1024 * 1024;
let child: ChildProcess | undefined;
let starting: Promise<void> | undefined;
let stopping = false;

process.on("message", (value: SandboxStart | ExtensionInboundMessage) => {
  if (value.type === "sandbox-start") {
    if (starting) return void stop();
    starting = start(value);
    void starting.catch(async (error: unknown) => {
      await send({
        type: "error",
        executionId: null,
        code: "EXTENSION_SANDBOX_UNAVAILABLE",
        message:
          error instanceof Error
            ? error.message
            : "Extension isolation is unavailable.",
        errorName: "SandboxError",
      });
      await stop();
    });
    return;
  }
  void starting?.then(() => {
    const line = `${JSON.stringify(value)}\n`;
    if (
      Buffer.byteLength(line) > maximumMessageBytes ||
      !child?.stdin?.write(line)
    ) {
      // Backpressure is bounded by a single protocol message, never an unbounded queue.
      if (Buffer.byteLength(line) > maximumMessageBytes) void stop();
    }
  });
});

process.once("disconnect", () => void stop());
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());

async function start(options: SandboxStart): Promise<void> {
  if (!SandboxManager.isSupportedPlatform())
    throw new Error("This operating system cannot isolate extensions.");
  const dependencies = await SandboxManager.checkDependenciesAsync();
  if (dependencies.errors.length)
    throw new Error(
      `Extension sandbox prerequisites are missing: ${dependencies.errors.join("; ")}`,
    );
  const executable = await realpath(process.execPath);
  const worker = await realpath(options.workerPath);
  const directory = await realpath(options.extensionDirectory);
  // Only immutable code and public operating-system runtime files are readable.
  // Node's narrower fs permissions are additional protection, not the sandbox.
  const systemPaths =
    process.platform === "win32"
      ? [
          join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
          join(process.env.SystemRoot ?? "C:\\Windows", "WinSxS"),
        ]
      : process.platform === "darwin"
        ? [
            "/System/Library",
            "/usr/lib",
            "/bin",
            "/Library/Apple/System/Library",
            "/dev/null",
            "/dev/urandom",
            "/private/etc/ssl/cert.pem",
          ]
        : [
            "/usr/lib",
            "/usr/lib64",
            "/usr/bin",
            "/bin",
            "/lib",
            "/lib64",
            "/dev/null",
            "/dev/urandom",
            "/etc/ld.so.cache",
            "/etc/ssl/certs",
          ];
  if (process.platform === "darwin")
    systemPaths.push(...(await linkedLibraries(executable)));
  const readRoots =
    process.platform === "win32"
      ? (
          await Promise.all(
            Array.from({ length: 26 }, async (_, index) => {
              const root = `${String.fromCharCode(65 + index)}:\\`;
              try {
                await stat(root);
                return root;
              } catch {
                return undefined;
              }
            }),
          )
        ).filter((path): path is string => path !== undefined)
      : [parse(directory).root];
  if (!readRoots.includes(parse(directory).root))
    readRoots.push(parse(directory).root);
  await SandboxManager.initialize(
    {
      network: {
        allowedDomains: [...options.network],
        deniedDomains: [],
        allowLocalBinding: false,
        allowUnixSockets: [],
      },
      filesystem: {
        denyRead: readRoots.map((path) => ({ path, literal: true })),
        allowRead: [directory, worker, executable, ...systemPaths].map(
          (path) => ({ path, literal: true }),
        ),
        allowWrite: [],
        // SRT's interactive-shell defaults include a shared temporary directory.
        // Extension code has no writable filesystem; do not inherit that grant.
        denyWrite:
          process.platform === "win32"
            ? []
            : ["/tmp/claude", "/private/tmp/claude"].map((path) => ({
                path,
                literal: true,
              })),
      },
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      allowAppleEvents: false,
    },
    async () => false,
  );
  if (!SandboxManager.isSandboxingEnabled())
    throw new Error("Extension sandbox enforcement is disabled.");
  const args = [
    executable,
    "--permission",
    `--allow-fs-read=${directory}`,
    `--allow-fs-read=${worker}`,
    "--allow-net",
    "--use-env-proxy",
    "--max-old-space-size=128",
    worker,
  ];
  const command = `${process.platform === "win32" ? "& " : ""}${args.map(quoteArgument).join(" ")}`;
  const wrapped = await SandboxManager.wrapWithSandboxArgv(
    command,
    process.platform === "win32" ? "powershell" : undefined,
    undefined,
    undefined,
    directory,
  );
  const [file, ...wrappedArgs] = wrapped.argv;
  if (!file)
    throw new Error("Extension sandbox did not produce an executable command.");
  // The supervisor itself starts with an allowlisted environment. The wrapper
  // adds only the authenticated per-extension proxy and OS bootstrap settings.
  child = spawn(file, wrappedArgs, {
    cwd: directory,
    env: wrapped.env,
    stdio:
      process.platform === "win32"
        ? ["pipe", "pipe", "pipe"]
        : ["pipe", "ignore", "pipe", "pipe"],
  });
  const protocol = process.platform === "win32" ? child.stdout : child.stdio[3];
  if (!protocol || !("on" in protocol))
    throw new Error("Extension protocol pipe is unavailable.");
  let buffered = "";
  const decoder = new StringDecoder("utf8");
  protocol.on("data", (chunk: Buffer) => {
    buffered += decoder.write(chunk);
    if (Buffer.byteLength(buffered) > maximumMessageBytes) return void stop();
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      try {
        send(JSON.parse(line) as ExtensionOutboundMessage);
      } catch {
        void stop();
        return;
      }
    }
  });
  // Never forward an extension's arbitrary stderr (it may contain secrets).
  child.stderr?.resume();
  child.once("error", () => void stop());
  child.once("exit", () => void stop());
}

function send(value: ExtensionOutboundMessage): Promise<void> {
  if (
    !process.connected ||
    Buffer.byteLength(JSON.stringify(value)) > maximumMessageBytes
  )
    return Promise.resolve();
  return new Promise((resolve) => {
    process.send?.(value, () => resolve());
  });
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  child?.kill("SIGKILL");
  const force = setTimeout(() => process.exit(1), 2_000);
  force.unref();
  try {
    await SandboxManager.reset();
  } finally {
    process.exit(0);
  }
}

function quoteArgument(value: string): string {
  if (value.includes("\0")) throw new Error("Invalid process argument.");
  return process.platform === "win32"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

async function linkedLibraries(executable: string): Promise<string[]> {
  const libraries = new Set<string>();
  const pending = [executable];
  while (pending.length) {
    const file = pending.pop()!;
    const result = await executeCommand("/usr/bin/otool", ["-L", file]);
    if (!result.success)
      throw new Error(
        "Cannot determine the Node.js runtime's native libraries.",
      );
    for (const line of new TextDecoder()
      .decode(result.stdout)
      .split("\n")
      .slice(1)) {
      const dependency = line.trim().split(" (", 1)[0];
      if (
        !dependency ||
        dependency.startsWith("/usr/lib/") ||
        dependency.startsWith("/System/Library/")
      )
        continue;
      if (!dependency.startsWith("/"))
        throw new Error(
          "Use the official standalone Node.js runtime: relative native library paths cannot be granted safely.",
        );
      const path = await realpath(dependency);
      if (path === executable || libraries.has(path)) continue;
      libraries.add(path);
      pending.push(path);
    }
  }
  return [...libraries];
}
