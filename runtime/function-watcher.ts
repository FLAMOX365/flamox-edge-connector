import { isNotFound } from "./files.ts";
import * as fs from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RuntimeLogger } from "./logger.ts";

export type FunctionWatcherOptions = {
  functionsDir: string;
  reload: (reason: string) => Promise<void>;
  signal: AbortSignal;
  logger: RuntimeLogger;
  debounceMs?: number;
  retryDelayMs?: number;
};

const defaultDebounceMs = 250;
const defaultRetryDelayMs = 1_000;

export async function watchFunctionsDirectory(
  options: FunctionWatcherOptions,
): Promise<void> {
  const functionsDir = resolve(options.functionsDir);
  let watcher: ReturnType<typeof fs.watch> | undefined;
  const closeWatcher = () => void watcher?.return?.();
  options.signal.addEventListener("abort", closeWatcher, { once: true });

  try {
    while (!options.signal.aborted) {
      const watchPath = await findExistingWatchPath(functionsDir);
      try {
        options.logger.info(
          `Watching functions directory ${functionsDir} via ${watchPath}`,
        );
        watcher = fs.watch(watchPath, {
          recursive: true,
          signal: options.signal,
        });

        for await (const event of watcher) {
          if (options.signal.aborted) {
            break;
          }
          if (
            event.filename !== null &&
            !isFunctionsPath(
              functionsDir,
              resolve(watchPath, event.filename.toString()),
            )
          ) {
            continue;
          }

          options.logger.info(
            `Functions directory changed (${event.eventType}); reloading routes`,
          );
          await sleep(options.debounceMs ?? defaultDebounceMs, options.signal);
          if (!options.signal.aborted) {
            await options.reload(`filesystem ${event.eventType}`);
          }
        }
      } catch (error) {
        if (!options.signal.aborted) {
          options.logger.warn("Functions watcher stopped; restarting", error);
        }
      } finally {
        void watcher?.return?.();
        watcher = undefined;
      }

      if (!options.signal.aborted) {
        await sleep(
          options.retryDelayMs ?? defaultRetryDelayMs,
          options.signal,
        );
      }
    }
  } finally {
    options.signal.removeEventListener("abort", closeWatcher);
    void watcher?.return?.();
  }
}

export function isFunctionsPath(functionsDir: string, path: string): boolean {
  const normalizedFunctionsDir = normalizePath(resolve(functionsDir));
  const normalizedPath = normalizePath(resolve(path));
  return (
    normalizedPath === normalizedFunctionsDir ||
    normalizedPath.startsWith(`${normalizedFunctionsDir}/`)
  );
}

async function findExistingWatchPath(path: string): Promise<string> {
  let current = resolve(path);

  while (true) {
    try {
      const stat = await fs.stat(current);
      return stat.isDirectory() ? current : dirname(current);
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timeoutId = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeoutId);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
