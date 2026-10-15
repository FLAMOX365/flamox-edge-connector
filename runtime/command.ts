import { spawn, type SpawnOptions } from "node:child_process";

export type CommandResult = {
  readonly code: number;
  readonly success: boolean;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
};

/** Executes an argument vector without a shell and bounds captured output. */
export function executeCommand(
  executable: string,
  args: readonly string[],
  options: Pick<SpawnOptions, "cwd" | "env"> & { inherit?: boolean } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let bytes = 0;
    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) {
        child.kill("SIGKILL");
        reject(new Error("Process output exceeds the capture limit."));
        return;
      }
      target.push(chunk);
    };
    child.stdout?.on("data", capture(stdout));
    child.stderr?.on("data", capture(stderr));
    child.once("error", reject);
    child.once("exit", (code) =>
      resolve({
        code: code ?? 1,
        success: code === 0,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }),
    );
  });
}
