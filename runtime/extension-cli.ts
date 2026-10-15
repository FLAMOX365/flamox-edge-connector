import { makeTempDirectory } from "./files.ts";
import * as fs from "node:fs/promises";
import { loadConfig } from "./config.ts";
import {
  createExtensionBundle,
  extractExtensionBundle,
  readExtensionBundle,
  writeExtensionBundle,
} from "./extension-bundle.ts";
import {
  computeExtensionDigest,
  parseExtensionReleaseDescriptor,
} from "./extension-integrity.ts";
import { parseExtensionConfiguration } from "./extension-manager.ts";
import { parseExtensionGrant } from "./extension-policy.ts";
import {
  generatePublisherKey,
  signExtensionRelease,
} from "./extension-publisher.ts";
import { createExtensionManager } from "./main.ts";

const usage = `Usage:
  yarn extensions list
  yarn extensions digest <package-dir>
  yarn extensions keygen <publisher> <key-id> <private-key.jwk> <trust.json>
  yarn extensions sign <package-dir> <private-key.jwk> <key-id> <release.json>
  yarn extensions pack <package-dir> <release.json> <output.fmx>
  yarn extensions install <package-dir> <release.json> <grant.json> [configuration.json] [--disabled]
  yarn extensions install-bundle <bundle.fmx> <grant.json> [configuration.json] [--disabled]
  yarn extensions reconfigure <extension-id> <configuration.json> [grant.json]
  yarn extensions activate <extension-id>
  yarn extensions disable <extension-id>
  yarn extensions rollback <extension-id> [version]
  yarn extensions uninstall <extension-id>`;

export async function runExtensionCli(args: readonly string[]): Promise<void> {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const [command, ...parameters] = normalizedArgs;
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    console.log(usage);
    return;
  }

  if (command === "pack") {
    requireCount(parameters, 3);
    const bundle = await createExtensionBundle(
      parameters[0]!,
      await readJson(parameters[1]!),
    );
    await writeExtensionBundle(bundle, parameters[2]!);
    console.log(`Extension bundle written to '${parameters[2]}'.`);
    return;
  }

  if (command === "digest") {
    requireCount(parameters, 1);
    console.log(await computeExtensionDigest(parameters[0]!));
    return;
  }

  if (command === "keygen") {
    requireCount(parameters, 4);
    const pair = await generatePublisherKey(parameters[0]!, parameters[1]!);
    await writeJson(parameters[2]!, pair.privateKey);
    try {
      await writeJson(parameters[3]!, pair.trust);
    } catch (error) {
      await fs.rm(parameters[2]!).catch(() => undefined);
      throw error;
    }
    console.log(
      `Private publisher key written to '${
        parameters[2]
      }'; public trust entry written to '${parameters[3]}'.`,
    );
    return;
  }

  if (command === "sign") {
    requireCount(parameters, 4);
    const release = await signExtensionRelease(
      parameters[0]!,
      await readJson(parameters[1]!),
      parameters[2]!,
    );
    await writeJson(parameters[3]!, release);
    console.log(`Signed release written to '${parameters[3]}'.`);
    return;
  }

  const manager = await createExtensionManager(loadConfig());
  try {
    switch (command) {
      case "list": {
        requireCount(parameters, 0);
        console.log(
          JSON.stringify(
            manager.list().map((state) => ({
              id: state.extensionId,
              version: state.version,
              status: state.status,
              installedAt: state.installedAt,
              activatedAt: state.activatedAt,
              lastErrorCode: state.lastErrorCode,
            })),
            null,
            2,
          ),
        );
        return;
      }
      case "install": {
        const disabled = parameters.at(-1) === "--disabled";
        const values = disabled ? parameters.slice(0, -1) : parameters;
        if (values.length < 3 || values.length > 4) invalidUsage();
        const sourceDirectory = values[0]!;
        const releaseFile = values[1]!;
        const grantFile = values[2]!;
        const configurationFile = values[3];
        const state = await manager.install({
          sourceDirectory,
          release: parseExtensionReleaseDescriptor(await readJson(releaseFile)),
          grant: parseExtensionGrant(await readJson(grantFile)),
          configuration: parseExtensionConfiguration(
            configurationFile ? await readJson(configurationFile) : {},
          ),
          activate: !disabled,
        });
        console.log(
          `Extension '${state.extensionId}' ${state.status.toLowerCase()} at ${state.version}.`,
        );
        return;
      }
      case "install-bundle": {
        const disabled = parameters.at(-1) === "--disabled";
        const values = disabled ? parameters.slice(0, -1) : parameters;
        if (values.length < 2 || values.length > 3) invalidUsage();
        const bundle = await readExtensionBundle(values[0]!);
        const sourceDirectory = await makeTempDirectory(
          "edge-extension-bundle-",
        );
        await fs.rmdir(sourceDirectory);
        try {
          await extractExtensionBundle(bundle, sourceDirectory);
          const state = await manager.install({
            sourceDirectory,
            release: bundle.release,
            grant: parseExtensionGrant(await readJson(values[1]!)),
            configuration: parseExtensionConfiguration(
              values[2] ? await readJson(values[2]) : {},
            ),
            activate: !disabled,
          });
          console.log(
            `Extension '${state.extensionId}' ${state.status.toLowerCase()} at ${state.version}.`,
          );
        } finally {
          await fs
            .rm(sourceDirectory, { recursive: true })
            .catch(() => undefined);
        }
        return;
      }
      case "reconfigure": {
        if (parameters.length < 2 || parameters.length > 3) invalidUsage();
        const state = await manager.reconfigure(parameters[0]!, {
          configuration: parseExtensionConfiguration(
            await readJson(parameters[1]!),
          ),
          grant: parameters[2]
            ? parseExtensionGrant(await readJson(parameters[2]))
            : undefined,
        });
        console.log(`Extension '${state.extensionId}' was reconfigured.`);
        return;
      }
      case "activate":
      case "disable": {
        requireCount(parameters, 1);
        const extensionId = parameters[0]!;
        const state =
          command === "activate"
            ? await manager.activate(extensionId)
            : await manager.disable(extensionId);
        console.log(
          `Extension '${state.extensionId}' is ${state.status.toLowerCase()}.`,
        );
        return;
      }
      case "uninstall": {
        requireCount(parameters, 1);
        await manager.uninstall(parameters[0]!);
        return;
      }
      case "rollback": {
        if (parameters.length < 1 || parameters.length > 2) invalidUsage();
        const state = await manager.rollback(parameters[0]!, parameters[1]);
        console.log(
          `Extension '${state.extensionId}' rolled back to ${state.version}.`,
        );
        return;
      }
      default:
        invalidUsage();
    }
  } finally {
    manager.stop();
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    const info = await fs.stat(path);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) {
      throw new Error("JSON input is missing or exceeds 2097152 bytes.");
    }
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read JSON file '${path}'.`, { cause: error });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function requireCount(values: readonly string[], expected: number): void {
  if (values.length !== expected) invalidUsage();
}

function invalidUsage(): never {
  throw new Error(usage);
}

if (import.meta.main) {
  try {
    await runExtensionCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
