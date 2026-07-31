import { basename, join, resolve } from "@std/path";
import type { JsonValue } from "../sdk/extension.ts";
import type { ExtensionBundle } from "../runtime/extension-bundle.ts";
import { parseTrustedPublishers } from "../runtime/extension-integrity.ts";
import { CloudClient } from "./cloud-client.ts";
import { type CliConfig, CliConfigStore } from "./config.ts";
import {
  buildProject,
  createProject,
  executeDevelopmentAction,
  packageProject,
  testProject,
  validateProject,
} from "./project.ts";

const usage = `Extension CLI

Usage:
  extension init [directory] [--id <id>] [--name <display-name>] [--description <text>]
                 [--publisher <name>] [--version <semver>] [--area <telephony>] [--key-id <id>]
                 [--sdk-source <module>] [--cloud <https-url>]
                 [--scope <system|tenant>] [--publish] [--yes]
  extension create <id> [--directory <path>] [--name <display-name>] [--publisher <name>]
  extension validate [directory]
  extension test [directory]
  extension dev [directory] [--action <name>] [--input <json> | --input-file <path>] [--once]
  extension build [directory] [--output <path>]
  extension pack [directory] [--output <file>] [--key <private.jwk>] [--key-id <id>]
  extension publish [directory]
  extension publisher init --name <publisher> --key-id <id>
  extension cloud configure --url <https-url> [--scope <system|tenant>]
  extension login --token <publisher-token>

The existing Edge Connector operator commands remain available through
\`deno task extensions\`.`;

export async function runCli(
  args: readonly string[],
  configStore = new CliConfigStore(),
  ask: PromptFunction = globalThis.prompt,
): Promise<void> {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  const [command, ...remaining] = normalized;
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log(usage);
    return;
  }
  if (command === "init") {
    const parsed = parseArguments(remaining);
    exactPositionals(parsed, parsed.positionals.length === 0 ? 0 : 1);
    exactFlags(parsed, [
      "id",
      "directory",
      "name",
      "description",
      "publisher",
      "version",
      "area",
      "key-id",
      "sdk-source",
      "cloud",
      "scope",
      "publish",
      "skip-pack",
      "yes",
    ]);
    const automatic = booleanFlag(parsed, "yes");
    const requestedDirectory = parsed.positionals[0];
    const suggestedId = requestedDirectory
      ? basename(resolve(requestedDirectory))
      : "hello-world";
    const id = wizardValue(
      parsed,
      "id",
      "Extension id",
      suggestedId,
      automatic,
      ask,
    );
    const directory = requestedDirectory ??
      wizardValue(
        parsed,
        "directory",
        "Target directory",
        `./${id}`,
        automatic,
        ask,
      );
    const displayName = wizardValue(
      parsed,
      "name",
      "Display name",
      titleCase(id),
      automatic,
      ask,
    );
    const description = wizardValue(
      parsed,
      "description",
      "Description",
      "Displays a Hello World message on the connected system.",
      automatic,
      ask,
    );
    let config = await configStore.load();
    const publisher = wizardValue(
      parsed,
      "publisher",
      "Publisher",
      config.publisher?.name ?? "FLAMOX365",
      automatic,
      ask,
    );
    const version = wizardValue(
      parsed,
      "version",
      "Initial version",
      "0.1.0",
      automatic,
      ask,
    );
    const area = areaFlag(parsed) ??
      (!automatic
        ? normalizeArea(
          optionalWizardValue("Extension area (optional: telephony)", "", ask),
        )
        : undefined);
    if (!config.publisher) {
      const keyId = wizardValue(
        parsed,
        "key-id",
        "Publisher key id",
        `${slug(publisher)}-${new Date().getUTCFullYear()}`,
        automatic,
        ask,
      );
      config = await configStore.initializePublisher(publisher, keyId);
      console.log(
        `Created publisher identity. Register '${
          config.publisher!.trustPath
        }'. It is registered with FLAMOX365 automatically on first publication.`,
      );
    } else if (config.publisher.name !== publisher) {
      throw new Error(
        `Configured publisher key belongs to '${config.publisher.name}', not '${publisher}'.`,
      );
    }
    const cloudUrl = textFlag(parsed, "cloud") ??
      (!automatic && !config.cloud?.url
        ? optionalWizardValue(
          "FLAMOX365 Cloud URL (optional)",
          "",
          ask,
        )
        : config.cloud?.url);
    const cloudScope = scopeFlag(parsed) ?? config.cloud?.scope ?? "system";
    if (
      cloudUrl &&
      (cloudUrl !== config.cloud?.url || cloudScope !== config.cloud?.scope)
    ) {
      config = {
        ...config,
        cloud: { ...config.cloud, url: cloudUrl, scope: cloudScope },
      };
      await configStore.save(config);
    }
    await createProject({
      id,
      directory,
      displayName,
      description,
      publisher,
      version,
      area,
      sdkSource: textFlag(parsed, "sdk-source"),
    });
    await testProject(directory);
    console.log(
      `Created and tested extension '${id}' in '${resolve(directory)}'.`,
    );

    const publishRequested = booleanFlag(parsed, "publish");
    if (booleanFlag(parsed, "skip-pack") && publishRequested) {
      throw new Error("--publish cannot be combined with --skip-pack.");
    }
    const packRequested = !booleanFlag(parsed, "skip-pack") &&
      (automatic || publishRequested ||
        wizardConfirmation("Create a signed .fmx package now?", true, ask));
    let packaged: Awaited<ReturnType<typeof packageProject>> | undefined;
    if (packRequested) {
      packaged = await packageProject(
        directory,
        config.publisher!.privateKeyPath,
        config.publisher!.keyId,
      );
      console.log(`Created signed bundle '${packaged.path}'.`);
    }
    const accessToken = cloudToken(config);
    const interactivePublish = !automatic && packaged &&
      config.cloud?.url && accessToken &&
      wizardConfirmation(
        "Upload the release to FLAMOX365 as a draft now?",
        false,
        ask,
      );
    if (publishRequested || interactivePublish) {
      if (!packaged) {
        throw new Error("A signed package is required before publishing.");
      }
      await publishBundle(config, accessToken, packaged.bundle);
    } else if (!config.cloud?.url || !accessToken) {
      console.log(
        "Publishing is ready after 'extension cloud configure' and 'extension login'.",
      );
    }
    return;
  }
  if (command === "create") {
    const parsed = parseArguments(remaining);
    const id = requiredPositional(parsed, 0, "extension id");
    exactPositionals(parsed, 1);
    exactFlags(parsed, [
      "directory",
      "name",
      "description",
      "publisher",
      "version",
      "area",
    ]);
    const config = await configStore.load();
    const directory = textFlag(parsed, "directory") ?? id;
    const displayName = textFlag(parsed, "name") ?? titleCase(id);
    const publisher = textFlag(parsed, "publisher") ??
      config.publisher?.name;
    if (!publisher) {
      throw new Error(
        "Publisher is required. Run 'extension publisher init' or pass --publisher.",
      );
    }
    await createProject({
      id,
      directory,
      displayName,
      description: textFlag(parsed, "description"),
      publisher,
      version: textFlag(parsed, "version"),
      area: areaFlag(parsed),
    });
    console.log(`Created extension '${id}' in '${resolve(directory)}'.`);
    return;
  }
  if (command === "publisher") {
    const [subcommand, ...parameters] = remaining;
    if (subcommand !== "init") invalidUsage();
    const parsed = parseArguments(parameters);
    exactPositionals(parsed, 0);
    exactFlags(parsed, ["name", "key-id"]);
    const config = await configStore.initializePublisher(
      requiredTextFlag(parsed, "name"),
      requiredTextFlag(parsed, "key-id"),
    );
    console.log(
      `Publisher '${config.publisher!.name}' initialized. Register '${
        config.publisher!.trustPath
      }'. FLAMOX365 registers it automatically on publication; keep '${
        config.publisher!.privateKeyPath
      }' private.`,
    );
    return;
  }
  if (command === "cloud") {
    const [subcommand, ...parameters] = remaining;
    if (subcommand !== "configure") invalidUsage();
    const parsed = parseArguments(parameters);
    exactPositionals(parsed, 0);
    exactFlags(parsed, ["url", "scope"]);
    const current = await configStore.load();
    await configStore.save({
      ...current,
      cloud: {
        ...current.cloud,
        url: requiredTextFlag(parsed, "url"),
        scope: scopeFlag(parsed) ?? current.cloud?.scope ?? "system",
      },
    });
    console.log("FLAMOX365 Cloud configured.");
    return;
  }
  if (command === "login") {
    const parsed = parseArguments(remaining);
    exactPositionals(parsed, 0);
    exactFlags(parsed, ["token"]);
    const current = await configStore.load();
    if (!current.cloud?.url) {
      throw new Error("Configure FLAMOX365 Cloud before logging in.");
    }
    await configStore.save({
      ...current,
      cloud: {
        ...current.cloud,
        accessToken: textFlag(parsed, "token") ??
          Deno.env.get("EDGE_EXTENSION_CLOUD_TOKEN")?.trim() ??
          requiredTextFlag(parsed, "token"),
      },
    });
    console.log(
      "Publisher access token stored with user-only file permissions.",
    );
    return;
  }

  const parsed = parseArguments(remaining);
  const directory = parsed.positionals[0] ?? ".";
  exactPositionals(parsed, parsed.positionals.length === 0 ? 0 : 1);
  switch (command) {
    case "validate": {
      exactFlags(parsed, []);
      const manifest = await validateProject(directory);
      console.log(
        `Extension '${manifest.id}' ${manifest.version} is valid.`,
      );
      return;
    }
    case "test": {
      exactFlags(parsed, []);
      await testProject(directory);
      console.log("Extension tests passed.");
      return;
    }
    case "build": {
      exactFlags(parsed, ["output"]);
      const result = await buildProject(
        directory,
        textFlag(parsed, "output") ?? join(directory, "dist"),
      );
      console.log(`Built extension in '${result.directory}'.`);
      return;
    }
    case "pack": {
      exactFlags(parsed, ["output", "key", "key-id"]);
      const config = await configStore.load();
      const key = textFlag(parsed, "key") ?? config.publisher?.privateKeyPath;
      const keyId = textFlag(parsed, "key-id") ?? config.publisher?.keyId;
      if (!key || !keyId) {
        throw new Error(
          "Publisher key is missing. Run 'extension publisher init' or pass --key and --key-id.",
        );
      }
      const result = await packageProject(
        directory,
        key,
        keyId,
        textFlag(parsed, "output"),
      );
      console.log(`Created signed bundle '${result.path}'.`);
      return;
    }
    case "publish": {
      exactFlags(parsed, []);
      const config = await configStore.load();
      if (!config.publisher) {
        throw new Error("Initialize a publisher before publishing.");
      }
      const accessToken = cloudToken(config);
      if (!config.cloud?.url || !accessToken) {
        throw new Error(
          "Configure and log in to FLAMOX365 Cloud before publishing.",
        );
      }
      await testProject(directory);
      const packaged = await packageProject(
        directory,
        config.publisher.privateKeyPath,
        config.publisher.keyId,
      );
      await publishBundle(config, accessToken, packaged.bundle);
      return;
    }
    case "dev": {
      exactFlags(parsed, ["action", "input", "input-file", "once"]);
      if (parsed.flags.has("input") && parsed.flags.has("input-file")) {
        throw new Error("Use either --input or --input-file.");
      }
      const run = async () => {
        const output = await executeDevelopmentAction({
          directory,
          action: textFlag(parsed, "action"),
          input: await inputValue(parsed),
        });
        console.log(JSON.stringify(output, null, 2));
      };
      await run();
      if (booleanFlag(parsed, "once")) return;
      console.log("Watching extension files. Press Ctrl+C to stop.");
      await watchProject(directory, run);
      return;
    }
    default:
      invalidUsage();
  }
}

type ParsedArguments = {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
};

type PromptFunction = (
  message?: string,
  defaultValue?: string,
) => string | null;

function parseArguments(args: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    const name = value.slice(2, equals < 0 ? undefined : equals);
    if (!name || flags.has(name)) {
      throw new Error(`Invalid or duplicate option '${value}'.`);
    }
    if (equals >= 0) {
      flags.set(name, value.slice(equals + 1));
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { positionals, flags };
}

async function inputValue(parsed: ParsedArguments): Promise<JsonValue> {
  const inline = textFlag(parsed, "input");
  const path = textFlag(parsed, "input-file");
  if (inline !== undefined) return parseJsonValue(inline);
  if (path !== undefined) return parseJsonValue(await Deno.readTextFile(path));
  return null;
}

function parseJsonValue(value: string): JsonValue {
  const parsed: unknown = JSON.parse(value);
  if (!isJsonValue(parsed)) {
    throw new Error("Extension input must contain only JSON values.");
  }
  return parsed;
}

function wizardValue(
  parsed: ParsedArguments,
  flag: string,
  label: string,
  fallback: string,
  automatic: boolean,
  ask: PromptFunction,
): string {
  const explicit = textFlag(parsed, flag);
  if (explicit !== undefined) return explicit;
  if (automatic) return fallback;
  const answer = ask(label, fallback);
  if (answer === null) {
    throw new Error("Extension initialization was cancelled.");
  }
  return answer.trim() || fallback;
}

function optionalWizardValue(
  label: string,
  fallback: string,
  ask: PromptFunction,
): string | undefined {
  const answer = ask(label, fallback);
  if (answer === null) {
    throw new Error("Extension initialization was cancelled.");
  }
  return answer.trim() || undefined;
}

function areaFlag(parsed: ParsedArguments): "telephony" | undefined {
  return normalizeArea(textFlag(parsed, "area"));
}

function normalizeArea(value: string | undefined): "telephony" | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value !== "telephony") {
    throw new Error(`Unsupported extension area '${value}'.`);
  }
  return value;
}

function wizardConfirmation(
  label: string,
  fallback: boolean,
  ask: PromptFunction,
): boolean {
  const suffix = fallback ? "Y/n" : "y/N";
  const answer = ask(`${label} [${suffix}]`, "");
  if (answer === null) {
    throw new Error("Extension initialization was cancelled.");
  }
  const normalized = answer.trim().toLowerCase();
  if (!normalized) return fallback;
  if (
    normalized === "y" || normalized === "yes" || normalized === "j" ||
    normalized === "ja"
  ) {
    return true;
  }
  if (normalized === "n" || normalized === "no" || normalized === "nein") {
    return false;
  }
  throw new Error(`Please answer yes or no for '${label}'.`);
}

function cloudToken(config: CliConfig): string | undefined {
  return Deno.env.get("EDGE_EXTENSION_CLOUD_TOKEN")?.trim() ||
    config.cloud?.accessToken;
}

async function publishBundle(
  config: CliConfig,
  accessToken: string | undefined,
  bundle: ExtensionBundle,
): Promise<void> {
  if (!config.cloud?.url || !accessToken || !config.publisher) {
    throw new Error(
      "Configure the publisher and log in to FLAMOX365 Cloud before publishing.",
    );
  }
  const trusted = parseTrustedPublishers(
    JSON.parse(await Deno.readTextFile(config.publisher.trustPath)),
  ).find((candidate) => candidate.keyId === config.publisher!.keyId);
  if (!trusted) {
    throw new Error("Configured publisher public key is missing.");
  }
  const published = await new CloudClient(
    config.cloud.url,
    accessToken,
    config.cloud.scope,
  ).publish(bundle, trusted);
  console.log(
    `Published '${published.extensionId}' ${published.version} as ${published.status}.`,
  );
}

async function watchProject(
  directory: string,
  run: () => Promise<void>,
): Promise<void> {
  const watcher = Deno.watchFs(directory);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for await (const event of watcher) {
      if (
        event.paths.every((path) =>
          path.includes("/dist/") || path.includes("/.edge/") ||
          path.includes("/.git/")
        )
      ) continue;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        void run().catch((error) =>
          console.error(error instanceof Error ? error.message : error)
        );
      }, 150);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    watcher.close();
  }
}

function exactPositionals(parsed: ParsedArguments, count: number): void {
  if (parsed.positionals.length !== count) invalidUsage();
}

function exactFlags(
  parsed: ParsedArguments,
  allowed: readonly string[],
): void {
  for (const name of parsed.flags.keys()) {
    if (!allowed.includes(name)) {
      throw new Error(`Unsupported option '--${name}'.`);
    }
  }
}

function requiredPositional(
  parsed: ParsedArguments,
  index: number,
  label: string,
): string {
  const value = parsed.positionals[index];
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
}

function textFlag(parsed: ParsedArguments, name: string): string | undefined {
  const value = parsed.flags.get(name);
  if (value === undefined) return undefined;
  if (value === true || !value.trim()) {
    throw new Error(`Option '--${name}' requires a value.`);
  }
  return value;
}

function requiredTextFlag(parsed: ParsedArguments, name: string): string {
  const value = textFlag(parsed, name);
  if (!value) throw new Error(`Missing required option '--${name}'.`);
  return value;
}

function booleanFlag(parsed: ParsedArguments, name: string): boolean {
  const value = parsed.flags.get(name);
  if (value === undefined) return false;
  if (value !== true) {
    throw new Error(`Option '--${name}' does not accept a value.`);
  }
  return true;
}

function scopeFlag(
  parsed: ParsedArguments,
): "system" | "tenant" | undefined {
  const value = textFlag(parsed, "scope");
  if (value === undefined) return undefined;
  if (value !== "system" && value !== "tenant") {
    throw new Error("Option '--scope' must be 'system' or 'tenant'.");
  }
  return value;
}

function titleCase(value: string): string {
  return value.split(/[.-]/u)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function slug(value: string): string {
  const normalized = value.toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized || "publisher";
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null || typeof value === "boolean" ||
    typeof value === "string"
  ) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

function invalidUsage(): never {
  throw new Error(usage);
}

if (import.meta.main) {
  try {
    await runCli(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    Deno.exit(1);
  }
}
