import * as fs from "node:fs/promises";
import Ajv2020Module, {
  type AnySchema,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import { join } from "node:path";
import {
  TELEPHONY_PROVIDER_OPERATION_SCHEMAS,
  type TelephonyProviderOperation,
} from "@edge-connector/sdk/areas/telephony-schemas";
import type { JsonValue } from "@edge-connector/sdk/extension";
import type { ExtensionManifest } from "./extension-manifest.ts";
import { RuntimeError } from "./runtime-error.ts";

type ContractBoundary = "input" | "output";

const validatorCache = new WeakMap<
  ExtensionManifest,
  Map<string, ValidateFunction>
>();

/** Validates one action value against its signed or area-owned contract. */
export async function validateExtensionActionValue(
  extensionDirectory: string,
  manifest: ExtensionManifest,
  actionName: string,
  boundary: ContractBoundary,
  value: JsonValue,
): Promise<void> {
  const validator = await resolveValidator(
    extensionDirectory,
    manifest,
    actionName,
    boundary,
  );
  if (!validator || validator(value)) return;
  throw new RuntimeError(
    boundary === "input"
      ? "EXTENSION_ACTION_INPUT_INVALID"
      : "EXTENSION_ACTION_OUTPUT_INVALID",
    `Extension action '${actionName}' ${boundary} violates its contract (${
      validator.errors?.length ?? 0
    } validation errors).`,
  );
}

async function resolveValidator(
  extensionDirectory: string,
  manifest: ExtensionManifest,
  actionName: string,
  boundary: ContractBoundary,
): Promise<ValidateFunction | undefined> {
  const key = `${actionName}:${boundary}`;
  const cached = validatorCache.get(manifest)?.get(key);
  if (cached) return cached;
  const schema = await resolveSchema(
    extensionDirectory,
    manifest,
    actionName,
    boundary,
  );
  if (!schema) return undefined;
  let validator: ValidateFunction;
  try {
    validator = new Ajv2020Module.default({
      allErrors: true,
      coerceTypes: false,
      removeAdditional: false,
      strict: true,
      useDefaults: false,
      validateFormats: false,
    }).compile(schema as AnySchema);
  } catch (error) {
    throw new RuntimeError(
      "EXTENSION_ACTION_SCHEMA_INVALID",
      `Extension action '${actionName}' ${boundary} schema cannot be compiled.`,
      { cause: error },
    );
  }
  const manifestCache = validatorCache.get(manifest) ?? new Map();
  manifestCache.set(key, validator);
  validatorCache.set(manifest, manifestCache);
  return validator;
}

async function resolveSchema(
  extensionDirectory: string,
  manifest: ExtensionManifest,
  actionName: string,
  boundary: ContractBoundary,
): Promise<unknown | undefined> {
  for (const contribution of manifest.contributions) {
    const operation = Object.entries(contribution.operations).find(
      ([, mappedAction]) => mappedAction === actionName,
    )?.[0] as TelephonyProviderOperation | undefined;
    if (operation) {
      return TELEPHONY_PROVIDER_OPERATION_SCHEMAS[operation][boundary];
    }
  }
  const action = manifest.actions.find(
    (candidate) => candidate.name === actionName,
  );
  const schemaPath =
    boundary === "input" ? action?.inputSchema : action?.outputSchema;
  if (!schemaPath) return undefined;
  const path = join(extensionDirectory, schemaPath);
  const info = await fs.stat(path);
  if (!info.isFile() || info.size > 256 * 1024) {
    throw new RuntimeError(
      "EXTENSION_ACTION_SCHEMA_INVALID",
      `Extension action '${actionName}' ${boundary} schema is missing or too large.`,
    );
  }
  try {
    return JSON.parse(await fs.readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new RuntimeError(
      "EXTENSION_ACTION_SCHEMA_INVALID",
      `Extension action '${actionName}' ${boundary} schema is invalid JSON.`,
      { cause: error },
    );
  }
}
