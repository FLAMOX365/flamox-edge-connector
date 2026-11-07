import {
  SandboxManager,
  VENDORED_SRT_WIN_EXE,
} from "@anthropic-ai/sandbox-runtime";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { realpath } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { parse, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { executeCommand } from "./command.ts";
import { windowsReadRoots } from "./windows-sandbox-roots.ts";
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
const initialDirectory = process.cwd();
let child: ChildProcess | undefined;
let input: Writable | undefined;
let inputServer: Server | undefined;
let starting: Promise<void> | undefined;
let stopping = false;
let protocolFailed = false;

process.on(
  "message",
  (
    value: SandboxStart | ExtensionInboundMessage | { type: "sandbox-stop" },
  ) => {
    if (value.type === "sandbox-stop") return void stop();
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
    void starting?.then(
      () => {
        const line = `${JSON.stringify(value)}\n`;
        if (Buffer.byteLength(line) > maximumMessageBytes) return void stop();
        input?.write(line);
      },
      () => undefined,
    );
  },
);

process.once("disconnect", () => void stop());
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());

async function start(options: SandboxStart): Promise<void> {
  if (!SandboxManager.isSupportedPlatform())
    throw new Error("This operating system cannot isolate extensions.");
  const executable = await realpath(process.execPath);
  const worker = await realpath(options.workerPath);
  const directory = await realpath(options.extensionDirectory);
  const windowsBroker =
    process.platform === "win32"
      ? await realpath(VENDORED_SRT_WIN_EXE)
      : undefined;
  // The broker's secondary logon probe executes the broker itself from the
  // current directory as the sandbox account, after the drive masks are set.
  if (windowsBroker) process.chdir(directory);
  // Only immutable code and public operating-system runtime files are readable.
  // Node's narrower fs permissions are additional protection, not the sandbox.
  // The Windows sandbox account already has access to the OS runtime.
  const systemPaths =
    process.platform === "win32"
      ? []
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
  if (windowsBroker) systemPaths.push(windowsBroker);
  if (process.platform === "darwin")
    systemPaths.push(...(await linkedLibraries(executable)));
  // Linux hides the installation directory. Re-expose only the trusted
  // seccomp executable that the wrapper needs before launching Node.
  const seccompPath =
    process.platform === "linux"
      ? await realpath(
          join(
            dirname(
              fileURLToPath(
                import.meta.resolve("@anthropic-ai/sandbox-runtime"),
              ),
            ),
            "..",
            "vendor",
            "seccomp",
            process.arch,
            "apply-seccomp",
          ),
        )
      : undefined;
  if (seccompPath) systemPaths.push(seccompPath);
  const readRoots =
    process.platform === "win32"
      ? await windowsReadRoots(directory)
      : [parse(directory).root];
  const filesystem = {
    denyRead: readRoots.map((path) => ({ path, literal: true as const })),
    allowRead: [directory, worker, executable, ...systemPaths].map((path) => ({
      path,
      literal: true as const,
    })),
    allowWrite: [],
    // SRT's interactive-shell defaults include a shared temporary directory.
    // Extension code has no writable filesystem; do not inherit that grant.
    denyWrite:
      process.platform === "win32"
        ? []
        : ["/tmp/claude", "/private/tmp/claude"].map((path) => ({
            path,
            literal: true as const,
          })),
  };
  const windowsInput = windowsBroker
    ? await listenForWindowsInput()
    : undefined;
  await SandboxManager.initialize(
    {
      network: {
        allowedDomains: [
          ...options.network,
          ...(windowsInput ? [windowsInput.authority] : []),
        ],
        deniedDomains: [],
        allowLocalBinding: false,
        allowUnixSockets: [],
      },
      filesystem,
      ...(seccompPath ? { seccomp: { applyPath: seccompPath } } : {}),
      ...(windowsBroker
        ? { windows: { srtWin: { path: windowsBroker } } }
        : {}),
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      allowAppleEvents: false,
    },
    async () => false,
  );
  if (!SandboxManager.isSandboxingEnabled())
    throw new Error("Extension sandbox enforcement is disabled.");
  if (
    process.platform === "win32" &&
    SandboxManager.getWindowsProfileRead() !== "absent"
  ) {
    throw new Error(
      "The Windows extension sandbox requires profile access to be disabled.",
    );
  }
  const workerArgs = [
    "--permission",
    `--allow-fs-read=${directory}`,
    `--allow-fs-read=${worker}`,
    "--allow-net",
    "--use-env-proxy",
    // The supervisor resolves the worker path before isolation. Node's
    // JavaScript realpath would lstat each ancestor, including denied drives.
    ...(windowsBroker
      ? ["--preserve-symlinks-main", "--preserve-symlinks"]
      : []),
    "--max-old-space-size=128",
    worker,
    ...(windowsInput ? [windowsInput.authority, windowsInput.token] : []),
  ];
  // SRT appends the command text as the final argument to a custom shell.
  // On Windows launch the worker directly, with that final argument unused.
  const command = windowsBroker
    ? ""
    : [executable, ...workerArgs].map(quoteArgument).join(" ");
  // The read mask can cover /tmp after the wrapper's initial bind mounts.
  // Restore only the two sockets for this extension's authenticated proxy.
  const proxySockets = [
    SandboxManager.getLinuxHttpSocketPath(),
    SandboxManager.getLinuxSocksSocketPath(),
  ].filter((path) => path !== undefined);
  const wrapped = await SandboxManager.wrapWithSandboxArgv(
    command,
    windowsBroker ? { exe: executable, args: workerArgs } : undefined,
    proxySockets.length > 0
      ? {
          filesystem: {
            ...filesystem,
            allowRead: [
              ...filesystem.allowRead,
              ...proxySockets.map((path) => ({ path, literal: true as const })),
            ],
          },
        }
      : undefined,
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
        ? ["ignore", "pipe", "pipe"]
        : ["pipe", "ignore", "pipe", "pipe"],
  });
  const protocol = process.platform === "win32" ? child.stdout : child.stdio[3];
  if (!protocol || !("on" in protocol))
    throw new Error("Extension protocol pipe is unavailable.");
  let buffered = "";
  const decoder = new StringDecoder("utf8");
  protocol.on("data", (chunk: Buffer) => {
    if (stopping || protocolFailed) return;
    buffered += decoder.write(chunk);
    if (Buffer.byteLength(buffered) > maximumMessageBytes)
      return failProtocol();
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      try {
        send(JSON.parse(line) as ExtensionOutboundMessage);
      } catch {
        failProtocol();
        return;
      }
    }
  });
  // Never forward an extension's arbitrary stderr (it may contain secrets).
  child.stderr?.resume();
  child.once("error", () => void stop());
  child.once("exit", () => void stop());
  input = windowsInput
    ? await windowsInput.response
    : (child.stdin ?? undefined);
  input?.once("error", () => void stop());
}

async function listenForWindowsInput(): Promise<{
  authority: string;
  token: string;
  response: Promise<ServerResponse>;
}> {
  // The native Windows broker consumes stdin to launch its runner and does
  // not pass the caller's input through. Use a one-time loopback response via
  // this extension's own WFP-filtered proxy. The listener never serves content
  // to unauthenticated requests and stops accepting after the worker connects.
  const token = randomBytes(32).toString("hex");
  const { promise: response, resolve } =
    Promise.withResolvers<ServerResponse>();
  let connected = false;
  const server = createServer({ maxHeaderSize: 4096 }, (request, reply) => {
    if (
      connected ||
      request.method !== "GET" ||
      request.url !== "/" ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      reply.writeHead(403, { connection: "close" }).end();
      return;
    }
    connected = true;
    server.close();
    reply.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
    });
    reply.flushHeaders();
    reply.once("close", () => void stop());
    resolve(reply);
  });
  inputServer = server;
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Extension input channel has no local address.");
  return { authority: `127.0.0.1:${address.port}`, token, response };
}

function failProtocol(): void {
  protocolFailed = true;
  void send({
    type: "error",
    executionId: null,
    code: "EXTENSION_PROTOCOL_INVALID",
    message: "Extension protocol data is invalid.",
    errorName: "ProtocolError",
  }).finally(() => stop());
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
  const running = child;
  const closed =
    running && running.exitCode === null && running.signalCode === null
      ? once(running, "close").catch(() => undefined)
      : Promise.resolve();
  const terminate = setTimeout(() => running?.kill("SIGKILL"), 500);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  input?.end();
  inputServer?.close();
  inputServer?.closeAllConnections();
  try {
    await closed;
    clearTimeout(terminate);
    // Windows keeps the working directory locked for the life of the process.
    process.chdir(initialDirectory);
    await SandboxManager.reset();
  } finally {
    process.exit(0);
  }
}

function quoteArgument(value: string): string {
  if (value.includes("\0")) throw new Error("Invalid process argument.");
  return `'${value.replaceAll("'", "'\\''")}'`;
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
