import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { executeCommand, type CommandResult } from "../runtime/command.ts";
import { isNotFound } from "../runtime/files.ts";
import { makeTempDirectory } from "../runtime/files.ts";
import { readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import { walk } from "../runtime/files.ts";
import { basename, dirname, join, relative, resolve } from "node:path";
import Ajv2020Module, { type AnySchema } from "ajv/dist/2020.js";
import type { JsonValue } from "@edge-connector/sdk/extension";
import {
  createExtensionBundle,
  type ExtensionBundle,
  writeExtensionBundle,
} from "../runtime/extension-bundle.ts";
import {
  type ExtensionHostCapabilityProvider,
  InteractiveExtensionHostCapabilityProvider,
  NativeMessageBoxAdapter,
} from "../runtime/extension-host-capabilities.ts";
import {
  type ExtensionManifest,
  readExtensionManifest,
} from "../runtime/extension-manifest.ts";
import { resolveConfiguredNetworkTargets } from "../runtime/extension-policy.ts";
import { signExtensionRelease } from "../runtime/extension-publisher.ts";
import { ExtensionHost } from "../runtime/extension-host.ts";
import { writeBundleLicenses } from "./licenses.ts";

const projectIdentifierPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const extensionSdkSource = `file:${dirname(dirname(fileURLToPath(import.meta.resolve("@edge-connector/sdk"))))}`;
const maximumJsonSchemaBytes = 256 * 1024;
const maximumStoreImageBytes = 2 * 1024 * 1024;
const bundledEntrypoint = "runtime/extension.mjs";
const storeImageMediaTypes: ReadonlyMap<string, string> = new Map([
  ["store-image.jpeg", "image/jpeg"],
  ["store-image.jpg", "image/jpeg"],
  ["store-image.png", "image/png"],
  ["store-image.webp", "image/webp"],
] as const);

export type CreateProjectOptions = {
  readonly id: string;
  readonly directory: string;
  readonly displayName: string;
  readonly description?: string;
  readonly publisher: string;
  readonly version?: string;
  readonly sdkSource?: string;
  readonly area?: "telephony";
};

export type BuildResult = {
  readonly directory: string;
  readonly manifest: ExtensionManifest;
};

export type PackageResult = {
  readonly path: string;
  readonly bundle: ExtensionBundle;
};

export async function createProject(
  options: CreateProjectOptions,
): Promise<void> {
  if (!projectIdentifierPattern.test(options.id)) {
    throw new Error(
      "Extension id must be lowercase and may contain dots or hyphens.",
    );
  }
  requiredText(options.displayName, "display name");
  requiredText(
    options.description ??
      "Displays a Hello World message on the connected system.",
    "description",
    2_000,
  );
  requiredText(options.publisher, "publisher");
  const version = options.version ?? "0.1.0";
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)
  ) {
    throw new Error("Extension version must be a semantic version.");
  }
  const target = resolve(options.directory);
  try {
    await fs.stat(target);
    throw new Error(`Target directory '${target}' already exists.`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await fs.mkdir(join(target, "src"), { recursive: true, mode: 0o700 });
  await fs.mkdir(join(target, "translations"), {
    recursive: true,
    mode: 0o700,
  });
  await fs.mkdir(join(target, "examples"), { recursive: true, mode: 0o700 });
  const files = scaffoldFiles({ ...options, version });
  try {
    for (const [path, content] of Object.entries(files)) {
      await fs.writeFile(join(target, path), content, {
        flag: "wx",
        mode: 0o600,
      });
    }
    await installProjectDependencies(target);
  } catch (error) {
    await fs.rm(target, { recursive: true }).catch(() => undefined);
    throw error;
  }
}

export async function validateProject(
  directory: string,
): Promise<ExtensionManifest> {
  const root = await fs.realpath(directory);
  const manifest = await readExtensionManifest(root);
  await requireDependencyLock(root);
  for (const path of [
    manifest.runtime.entrypoint,
    manifest.configurationSchema,
    manifest.configurationUiSchema,
    manifest.notices,
    ...manifest.actions.flatMap((action) => [
      action.inputSchema,
      action.outputSchema,
    ]),
    ...Object.values(manifest.translations),
  ]) {
    if (!path) continue;
    const info = await fs.stat(join(root, path));
    if (!info.isFile()) {
      throw new Error(`Manifest resource '${path}' is not a file.`);
    }
  }
  for (const schemaPath of [
    manifest.configurationSchema,
    ...manifest.actions.flatMap((action) => [
      action.inputSchema,
      action.outputSchema,
    ]),
  ]) {
    if (schemaPath) await validateJsonSchema(root, schemaPath);
  }
  await validateProjectTree(root);
  await validateStoreImage(root);
  const prepared = await prepareBundledRuntime(root, manifest);
  try {
    const host = developmentHost(prepared.directory, prepared.manifest);
    try {
      await host.start();
    } finally {
      host.stop();
    }
  } finally {
    await fs.rm(prepared.directory, { recursive: true });
  }
  return manifest;
}

async function validateStoreImage(root: string): Promise<void> {
  const candidates = [...readdirSync(root, { withFileTypes: true })]
    .filter((entry) => entry.isFile() && entry.name.startsWith("store-image."))
    .map((entry) => entry.name)
    .sort();
  if (candidates.length === 0) return;
  if (candidates.length > 1) {
    throw new Error("Extension projects may contain only one Store image.");
  }
  const name = candidates[0]!;
  const mediaType = storeImageMediaTypes.get(name);
  if (!mediaType) {
    throw new Error(
      "Store images must be named store-image.png, store-image.jpg, store-image.jpeg or store-image.webp.",
    );
  }
  const path = join(root, name);
  const info = await fs.stat(path);
  if (!info.isFile() || info.size === 0 || info.size > maximumStoreImageBytes) {
    throw new Error("The Store image is empty or exceeds 2 MiB.");
  }
  const bytes = await fs.readFile(path);
  if (!matchesStoreImageType(bytes, mediaType)) {
    throw new Error(`The Store image '${name}' does not match its file type.`);
  }
}

function matchesStoreImageType(bytes: Uint8Array, mediaType: string): boolean {
  if (mediaType === "image/png") {
    return (
      bytes.length >= 8 &&
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
        (value, index) => bytes[index] === value,
      )
    );
  }
  if (mediaType === "image/jpeg") {
    return (
      bytes.length >= 4 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes.at(-2) === 0xff &&
      bytes.at(-1) === 0xd9
    );
  }
  return (
    bytes.length >= 12 &&
    new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP"
  );
}

async function validateJsonSchema(
  root: string,
  schemaPath: string,
): Promise<void> {
  const path = join(root, schemaPath);
  let schema: unknown;
  try {
    const info = await fs.stat(path);
    if (!info.isFile() || info.size > maximumJsonSchemaBytes) {
      throw new Error("Schema resource is missing or too large.");
    }
    schema = JSON.parse(await fs.readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`JSON Schema '${schemaPath}' cannot be read.`, {
      cause: error,
    });
  }
  try {
    new Ajv2020Module.default({
      allErrors: true,
      coerceTypes: false,
      removeAdditional: false,
      strict: true,
      useDefaults: false,
      validateFormats: false,
    }).compile(schema as AnySchema);
  } catch (error) {
    throw new Error(`JSON Schema '${schemaPath}' cannot be compiled.`, {
      cause: error,
    });
  }
}

export async function testProject(directory: string): Promise<void> {
  await validateProject(directory);
  const testFiles: string[] = [];
  for await (const entry of walk(directory, {
    includeDirs: false,
    includeSymlinks: false,
    skip: [/[/\\](?:dist|node_modules|\.yarn|\.git|\.edge)(?:[/\\]|$)/u],
  })) {
    if (
      entry.isFile() &&
      /\.(?:spec|test)\.(?:ts|mts|js|mjs)$/u.test(entry.name)
    )
      testFiles.push(entry.path);
  }
  if (testFiles.length === 0) {
    throw new Error("Extension project does not contain any test files.");
  }
  testFiles.sort();
  await typecheckProject(directory);
  // The CLI starts an independent test runner, including when invoked by host tests.
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const status = await executeCommand(
    process.execPath,
    [
      "--import",
      fileURLToPath(import.meta.resolve("tsx")),
      "--test",
      ...testFiles,
    ],
    { cwd: directory, inherit: true, env: environment },
  );
  if (!status.success) {
    throw new Error(`Extension tests failed with exit code ${status.code}.`);
  }
}

export async function buildProject(
  directory: string,
  outputDirectory = join(directory, "dist"),
): Promise<BuildResult> {
  const root = await fs.realpath(directory);
  const manifest = await validateProject(root);
  const nestedOutput = relative(resolve(directory), resolve(outputDirectory));
  if (
    !nestedOutput ||
    nestedOutput === ".." ||
    nestedOutput.startsWith(
      `..${(process.platform === "win32" ? "windows" : process.platform) === "windows" ? "\\" : "/"}`,
    )
  ) {
    throw new Error("Build output must be a child of the extension project.");
  }
  const output = resolve(root, nestedOutput);
  const staging = join(
    dirname(root),
    `.${basename(root)}-build-${crypto.randomUUID()}`,
  );
  await fs.rm(staging, { recursive: true }).catch((error) => {
    if (!isNotFound(error)) throw error;
  });
  await fs.mkdir(dirname(staging), { recursive: true, mode: 0o700 });
  try {
    await copyProjectFiles(root, staging);
    const builtManifest = {
      ...manifest,
      runtime: {
        kind: "node-process" as const,
        entrypoint: bundledEntrypoint,
      },
    };
    await bundleEntrypoint(
      root,
      manifest.runtime.entrypoint,
      join(staging, bundledEntrypoint),
      manifest.notices,
    );
    await fs.writeFile(
      join(staging, "extension-manifest.json"),
      `${JSON.stringify(builtManifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    const host = developmentHost(staging, builtManifest);
    try {
      await host.start();
    } finally {
      host.stop();
    }
    await fs.rm(output, { recursive: true }).catch((error) => {
      if (!isNotFound(error)) throw error;
    });
    await fs.rename(staging, output);
  } catch (error) {
    await fs.rm(staging, { recursive: true }).catch(() => undefined);
    throw error;
  }
  return {
    directory: output,
    manifest: {
      ...manifest,
      runtime: { kind: "node-process", entrypoint: bundledEntrypoint },
    },
  };
}

async function copyProjectFiles(root: string, target: string): Promise<void> {
  await fs.mkdir(target, { recursive: false, mode: 0o700 });
  for await (const entry of walk(root, {
    includeDirs: true,
    includeSymlinks: true,
    followSymlinks: false,
    skip: [
      /[/\\](?:dist|node_modules|\.yarn|\.git|\.edge|examples)(?:[/\\]|$)/u,
    ],
  })) {
    const nested = relative(root, entry.path);
    if (!nested) continue;
    if (entry.isSymbolicLink()) {
      throw new Error("Extension projects cannot contain symbolic links.");
    }
    if (/\.(?:ts|mts|js|mjs)$/u.test(entry.name)) {
      continue;
    }
    if (
      entry.isFile() &&
      (entry.name === ".gitignore" ||
        entry.name === "README.md" ||
        entry.name === "package.json" ||
        entry.name === "tsconfig.json" ||
        entry.name === "yarn.lock" ||
        entry.name === ".yarnrc.yml" ||
        /^grant(?:[.-].*)?\.json$/u.test(entry.name) ||
        /(?:^|\.)(?:jwk|pem|key)$/iu.test(entry.name) ||
        /^\.env(?:\.|$)/u.test(entry.name))
    ) {
      continue;
    }
    const destination = join(target, nested);
    if (entry.isDirectory()) {
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    } else if (entry.isFile()) {
      await fs.mkdir(dirname(destination), {
        recursive: true,
        mode: 0o700,
      });
      await fs.copyFile(entry.path, destination);
      await fs.chmod(destination, 0o600);
    }
  }
}

export async function packageProject(
  directory: string,
  privateKeyPath: string,
  publisherKeyId: string,
  outputPath?: string,
): Promise<PackageResult> {
  const build = await buildProject(directory);
  const privateKey = JSON.parse(await fs.readFile(privateKeyPath, "utf8"));
  const release = await signExtensionRelease(
    build.directory,
    privateKey,
    publisherKeyId,
  );
  const bundle = await createExtensionBundle(build.directory, release);
  const path = resolve(
    outputPath ??
      join(
        directory,
        ".edge",
        "releases",
        `${build.manifest.id}-${build.manifest.version}.fmx`,
      ),
  );
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeExtensionBundle(bundle, path);
  return { path, bundle };
}

export async function executeDevelopmentAction(options: {
  readonly directory: string;
  readonly action?: string;
  readonly input?: JsonValue;
  readonly configuration?: Readonly<Record<string, JsonValue>>;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly hostCapabilities?: ExtensionHostCapabilityProvider;
}): Promise<JsonValue> {
  const root = await fs.realpath(options.directory);
  const manifest = await validateProject(root);
  const prepared = await prepareBundledRuntime(root, manifest);
  const configuration = options.configuration ?? {};
  const action = options.action ?? manifest.actions[0]?.name;
  if (!action) throw new Error("Extension does not declare an action.");
  const host = new ExtensionHost({
    extensionDirectory: prepared.directory,
    manifest: prepared.manifest,
    grant: {
      capabilities: [...manifest.capabilities],
      network: [
        ...manifest.permissions.network,
        ...resolveConfiguredNetworkTargets(manifest, configuration),
      ],
      secrets: [...manifest.permissions.secrets],
    },
    configuration,
    secrets: {
      resolve: () => Promise.resolve(options.secrets ?? {}),
    },
    hostCapabilities:
      options.hostCapabilities ??
      new InteractiveExtensionHostCapabilityProvider(
        new NativeMessageBoxAdapter(),
      ),
  });
  try {
    return await host.execute(
      `dev-${crypto.randomUUID()}`,
      action,
      options.input ?? null,
    );
  } finally {
    host.stop();
    await fs.rm(prepared.directory, { recursive: true });
  }
}

async function installProjectDependencies(directory: string): Promise<void> {
  const output = await executeCommand("yarn", ["install"], { cwd: directory });
  if (!output.success) {
    throw commandError("Dependency installation", output);
  }
}

async function requireDependencyLock(root: string): Promise<void> {
  let current = root;
  while (true) {
    try {
      const info = await fs.stat(join(current, "yarn.lock"));
      if (info.isFile()) return;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("Extension dependencies must be locked. Run 'yarn install'.");
}

async function validateProjectTree(root: string): Promise<void> {
  for await (const entry of walk(root, {
    includeDirs: false,
    includeSymlinks: true,
    followSymlinks: false,
    skip: [/[/\\](?:dist|node_modules|\.yarn|\.git|\.edge)(?:[/\\]|$)/u],
  })) {
    if (entry.isSymbolicLink()) {
      throw new Error("Extension projects cannot contain symbolic links.");
    }
  }
}

async function prepareBundledRuntime(
  root: string,
  manifest: ExtensionManifest,
): Promise<{
  readonly directory: string;
  readonly manifest: ExtensionManifest;
}> {
  const directory = await makeTempDirectory("edge-extension-runtime-");
  const bundledManifest: ExtensionManifest = {
    ...manifest,
    runtime: { kind: "node-process", entrypoint: bundledEntrypoint },
  };
  try {
    await bundleEntrypoint(
      root,
      manifest.runtime.entrypoint,
      join(directory, bundledEntrypoint),
      manifest.notices,
    );
    return { directory, manifest: bundledManifest };
  } catch (error) {
    await fs.rm(directory, { recursive: true }).catch(() => undefined);
    throw error;
  }
}

async function bundleEntrypoint(
  root: string,
  entrypoint: string,
  outputPath: string,
  noticePath?: string | null,
): Promise<void> {
  await fs.mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await typecheckProject(root);
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entrypoint],
    outfile: outputPath,
    platform: "node",
    target: "node26",
    format: "esm",
    bundle: true,
    packages: "bundle",
    metafile: true,
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
    logLevel: "silent",
  });
  await writeBundleLicenses(
    root,
    join(dirname(outputPath), "THIRD_PARTY_LICENSES.txt"),
    result.metafile,
    noticePath,
  );
  await fs.chmod(outputPath, 0o600);
}

function developmentHost(
  directory: string,
  manifest: ExtensionManifest,
): ExtensionHost {
  return new ExtensionHost({
    extensionDirectory: directory,
    manifest,
    grant: {
      capabilities: [...manifest.capabilities],
      network: [...manifest.permissions.network],
      secrets: [...manifest.permissions.secrets],
    },
    configuration: {},
    secrets: { resolve: () => Promise.resolve({}) },
  });
}

function commandError(operation: string, output: CommandResult): Error {
  const detail = new TextDecoder().decode(output.stderr).trim();
  return new Error(
    `${operation} failed with exit code ${output.code}${
      detail ? `: ${detail}` : "."
    }`,
  );
}

function scaffoldFiles(
  options: CreateProjectOptions & { readonly version: string },
): Readonly<Record<string, string>> {
  if (options.area === "telephony") {
    return scaffoldTelephonyFiles(options);
  }
  const manifest = {
    $schema:
      "https://schemas.flamox.com/edge-connector/extension-manifest/v2.json",
    schemaVersion: 2,
    id: options.id,
    displayName: options.displayName,
    description:
      options.description ??
      "Displays a Hello World message on the connected system.",
    publisher: options.publisher,
    version: options.version,
    runtime: { kind: "node-process", entrypoint: "src/main.ts" },
    capabilities: ["host.ui.message-box"],
    permissions: { network: [], secrets: [] },
    actions: [
      {
        name: "show-message",
        description: "Displays a native message box.",
        idempotent: false,
        timeoutSeconds: 30,
      },
    ],
    contributions: [],
    translations: {
      de: "translations/de.json",
      en: "translations/en.json",
    },
    configurationSchema: "configuration.schema.json",
    configurationUiSchema: "configuration.ui.json",
  };
  return {
    "extension-manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    ...projectToolchain(options),
    ".gitignore":
      "dist/\nnode_modules/\n.yarn/install-state.gz\n.edge/\n*.jwk\n",
    "grant.dev.json": `${JSON.stringify(
      {
        capabilities: ["host.ui.message-box"],
        network: [],
        secrets: [],
      },
      null,
      2,
    )}\n`,
    "configuration.schema.json": `${JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: "Hello World configuration",
        type: "object",
        additionalProperties: false,
        properties: {
          defaultTitle: {
            type: "string",
            title: "Default message title",
            minLength: 1,
            maxLength: 200,
            default: "Hello from the Edge Connector",
          },
        },
      },
      null,
      2,
    )}\n`,
    "configuration.ui.json": `${JSON.stringify(
      {
        defaultTitle: {
          "ui:placeholder": "Hello from the Edge Connector",
        },
      },
      null,
      2,
    )}\n`,
    "examples/show-message.json": `${JSON.stringify(
      {
        title: "Hello from the Edge Connector",
        message: "The first extension is running.",
        kind: "info",
      },
      null,
      2,
    )}\n`,
    "translations/de.json": `${JSON.stringify(
      {
        displayName: options.displayName,
        description:
          "Zeigt eine Hello-World-Nachricht auf dem verbundenen System an.",
      },
      null,
      2,
    )}\n`,
    "translations/en.json": `${JSON.stringify(
      {
        displayName: options.displayName,
        description: "Displays a Hello World message on the connected system.",
      },
      null,
      2,
    )}\n`,
    "src/main.ts": extensionMainSource,
    "src/main.spec.ts": extensionTestSource,
    "README.md": `# ${options.displayName}

This is the first reference extension for the Edge Connector. It requests the
explicit \`host.ui.message-box\` capability and never receives direct process or
desktop permissions.

\`\`\`sh
extension test
extension dev --once --input-file examples/show-message.json
extension pack
extension publish
\`\`\`
`,
  };
}

function scaffoldTelephonyFiles(
  options: CreateProjectOptions & { readonly version: string },
): Readonly<Record<string, string>> {
  const manifest = {
    $schema:
      "https://schemas.flamox.com/edge-connector/extension-manifest/v2.json",
    schemaVersion: 2,
    id: options.id,
    displayName: options.displayName,
    description:
      options.description ?? "Provides telephony through the Edge Connector.",
    publisher: options.publisher,
    version: options.version,
    runtime: { kind: "node-process", entrypoint: "src/main.ts" },
    capabilities: [
      "telephony.provider.health.read",
      "telephony.call.start",
      "telephony.call.end",
      "telephony.call-history.read",
    ],
    permissions: { network: [], secrets: [] },
    actions: [
      { name: "dial", idempotent: false, timeoutSeconds: 30 },
      { name: "hangup", idempotent: true, timeoutSeconds: 30 },
      { name: "list-calls", idempotent: true, timeoutSeconds: 60 },
      { name: "health", idempotent: true, timeoutSeconds: 30 },
    ],
    contributions: [
      {
        id: "telephony-provider",
        area: "telephony",
        contract: "telephony.provider",
        contractVersion: 1,
        operations: {
          startCall: "dial",
          endCall: "hangup",
          synchronizeCalls: "list-calls",
          health: "health",
        },
      },
    ],
    translations: {
      de: "translations/de.json",
      en: "translations/en.json",
    },
    configurationSchema: "configuration.schema.json",
    configurationUiSchema: "configuration.ui.json",
    health: { action: "health", timeoutSeconds: 30 },
  };
  return {
    "extension-manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    ...projectToolchain(options),
    ".gitignore":
      "dist/\nnode_modules/\n.yarn/install-state.gz\n.edge/\n*.jwk\n",
    "grant.dev.json": `${JSON.stringify(
      { capabilities: manifest.capabilities, network: [], secrets: [] },
      null,
      2,
    )}\n`,
    "configuration.schema.json": `${JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: "Telephony provider configuration",
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      null,
      2,
    )}\n`,
    "configuration.ui.json": `${JSON.stringify(
      { schemaVersion: 1, sections: [], fields: {} },
      null,
      2,
    )}\n`,
    "examples/dial.json": `${JSON.stringify(
      {
        callIntentId: "00000000-0000-4000-8000-000000000000",
        phoneNumber: "+4930123456",
        actor: {
          userId: "1",
          address: "developer@example.com",
          displayName: "Developer",
        },
      },
      null,
      2,
    )}\n`,
    "translations/de.json": `${JSON.stringify(
      {
        displayName: options.displayName,
        description:
          "Stellt Telefoniefunktionen über den Edge Connector bereit.",
      },
      null,
      2,
    )}\n`,
    "translations/en.json": `${JSON.stringify(
      {
        displayName: options.displayName,
        description: "Provides telephony through the Edge Connector.",
      },
      null,
      2,
    )}\n`,
    "src/main.ts": telephonyMainSource,
    "src/main.spec.ts": telephonyTestSource,
    "README.md": `# ${options.displayName}\n\nThis extension implements the versioned telephony provider contract.\n`,
  };
}

const telephonyMainSource = `import { defineTelephonyProvider } from "@edge-connector/sdk";

export default defineTelephonyProvider({
  startCall: {
    action: "dial",
    handler: (_context, input) => ({
      status: "ACCEPTED",
      providerCallId: null,
      occurredAt: new Date().toISOString(),
      providerData: { phoneNumber: input.phoneNumber },
    }),
  },
  endCall: {
    action: "hangup",
    handler: () => ({ status: "ENDED", occurredAt: new Date().toISOString() }),
  },
  synchronizeCalls: {
    action: "list-calls",
    handler: (_context, input) => ({ calls: [], cursor: input.cursor ?? {} }),
  },
  health: {
    action: "health",
    handler: () => ({ healthy: true, message: null }),
  },
});
`;

const telephonyTestSource = `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport extension from "./main.ts";

test("telephony provider exposes every contract operation", () => {
  assert.deepEqual(Object.keys(extension.actions).sort(), ["dial", "hangup", "health", "list-calls"]);
});
`;

const extensionMainSource = `import { defineExtension, type JsonValue } from "@edge-connector/sdk";

export function parseMessage(
  input: JsonValue,
  defaultTitle?: JsonValue,
): {
  title: string;
  message: string;
  kind: "info" | "warning" | "error";
} {
  if (
    typeof input !== "object" || input === null || Array.isArray(input) ||
    (input.title !== undefined && typeof input.title !== "string") ||
    typeof input.message !== "string" ||
    (input.kind !== undefined &&
      input.kind !== "info" && input.kind !== "warning" && input.kind !== "error")
  ) {
    throw new Error("Input must contain message and optional title and kind.");
  }
  return {
    title: input.title ??
      (typeof defaultTitle === "string"
        ? defaultTitle
        : "Hello from the Edge Connector"),
    message: input.message,
    kind: input.kind ?? "info",
  };
}

export default defineExtension({
  actions: {
    "show-message": async ({ host, configuration }, input) => {
      const result = await host.ui.showMessage(
        parseMessage(input, configuration.defaultTitle),
      );
      return { displayed: result.displayed };
    },
  },
});
`;

const extensionTestSource = `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport extension from "./main.ts";

test("show-message delegates to the authorized host", async () => {
  const shown: unknown[] = [];
  const result = await extension.actions["show-message"]({
    requestId: "test",
    configuration: {},
    secrets: {},
    host: {
      ui: {
        showMessage: (request) => {
          shown.push(request);
          return Promise.resolve({ displayed: true as const });
        },
      },
    },
  }, {
    title: "Hello",
    message: "World",
    kind: "info",
  });
  assert.deepEqual(shown, [{ title: "Hello", message: "World", kind: "info" }]);
  assert.deepEqual(result, { displayed: true });
});
`;

function requiredText(value: string, label: string, maximumLength = 200): void {
  if (!value.trim() || value.length > maximumLength) {
    throw new Error(`Extension ${label} is invalid.`);
  }
}

async function typecheckProject(directory: string): Promise<void> {
  const require = createRequire(import.meta.url);
  const compiler = join(
    dirname(require.resolve("typescript/package.json")),
    "bin",
    "tsc",
  );
  const result = await executeCommand(
    process.execPath,
    [compiler, "--noEmit", "--project", join(directory, "tsconfig.json")],
    { cwd: directory },
  );
  if (!result.success)
    throw new Error(
      `Extension type checking failed: ${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`,
    );
}

function projectToolchain(
  options: CreateProjectOptions & { readonly version: string },
): Readonly<Record<string, string>> {
  const source = options.sdkSource;
  const sdk =
    source?.startsWith("file:") && /\.(?:ts|js)$/u.test(source)
      ? `file:${dirname(fileURLToPath(source))}`
      : (source ?? extensionSdkSource);
  const manifest = {
    name: options.id,
    version: options.version,
    private: true,
    type: "module",
    packageManager: "yarn@4.18.1",
    engines: { node: ">=26.0.0 <27" },
    scripts: {
      check: "tsc --noEmit",
      test: "node --import tsx --test src/*.spec.ts",
    },
    dependencies: { "@edge-connector/sdk": sdk },
    devDependencies: {
      typescript: "7.0.2",
      "@types/node": "26.6.5",
      tsx: "4.23.15",
    },
  };
  const config = {
    compilerOptions: {
      target: "ES2024",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      types: ["node"],
      lib: ["ES2024", "DOM", "DOM.Iterable"],
    },
    include: ["src/**/*.ts"],
  };
  return {
    "package.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "tsconfig.json": `${JSON.stringify(config, null, 2)}\n`,
    ".yarnrc.yml": "nodeLinker: node-modules\nenableScripts: false\n",
  };
}
