import { emptyDir } from "@std/fs/empty-dir";
import { join, resolve } from "@std/path";
import { parse } from "@std/yaml";

type OpenApiSchema = Readonly<Record<string, unknown>>;
type SchemaCatalog = ReadonlyMap<string, OpenApiSchema>;

const generatedHeader =
  "// Generated from OpenAPI schemas. Do not edit manually.";

export async function generateApiModels(
  sourceDirectory: string,
  outputDirectory: string,
): Promise<void> {
  const schemas = await readSchemas(sourceDirectory);
  if (schemas.size === 0) {
    throw new Error("No OpenAPI component schemas were found.");
  }

  const renderedModels = new Map<string, string>();
  for (const [name, schema] of schemas) {
    const fileName = `${toKebabCase(name)}.ts`;
    if (renderedModels.has(fileName)) {
      throw new Error(`OpenAPI component schemas collide at '${fileName}'.`);
    }
    renderedModels.set(fileName, renderModel(name, schema, schemas));
  }
  const barrel = renderBarrel(schemas);

  await emptyDir(outputDirectory);
  const modelsDirectory = join(outputDirectory, "models");
  await Deno.mkdir(modelsDirectory, { recursive: true });

  for (const [fileName, model] of renderedModels) {
    await Deno.writeTextFile(
      join(modelsDirectory, fileName),
      model,
    );
  }
  await Deno.writeTextFile(join(outputDirectory, "models.ts"), barrel);
}

async function readSchemas(
  sourceDirectory: string,
): Promise<Map<string, OpenApiSchema>> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(sourceDirectory)) {
    if (entry.isFile && /\.ya?ml$/u.test(entry.name)) files.push(entry.name);
  }
  files.sort();

  const schemas = new Map<string, OpenApiSchema>();
  for (const file of files) {
    const document = asRecord(
      parse(await Deno.readTextFile(join(sourceDirectory, file))),
      `OpenAPI document '${file}'`,
    );
    const components = asRecord(document.components, `'${file}' components`);
    const candidates = asRecord(
      components.schemas,
      `'${file}' component schemas`,
    );
    for (const [name, candidate] of Object.entries(candidates)) {
      if (!isTypeScriptIdentifier(name)) {
        throw new Error(
          `OpenAPI component schema '${name}' is not a safe TypeScript identifier.`,
        );
      }
      if (schemas.has(name)) {
        throw new Error(`Duplicate OpenAPI component schema '${name}'.`);
      }
      schemas.set(name, asRecord(candidate, `OpenAPI schema '${name}'`));
    }
  }
  return schemas;
}

function renderModel(
  name: string,
  schema: OpenApiSchema,
  schemas: SchemaCatalog,
): string {
  const imports = collectImports(schema, schemas, name);
  const lines = [generatedHeader];
  if (imports.size > 0) {
    lines.push("");
    for (
      const [path, symbols] of [...imports].sort(([left], [right]) =>
        left.localeCompare(right)
      )
    ) {
      lines.push(
        `import type { ${
          [...symbols].sort().join(", ")
        } } from "./${path}.ts";`,
      );
    }
  }

  lines.push("");
  if (isEnum(schema)) {
    const constant = `${toConstantCase(name)}_VALUES`;
    lines.push(
      `export const ${constant} = ${
        JSON.stringify(schema.enum, null, 2)
      } as const;`,
    );
    lines.push("");
    lines.push(`export type ${name} = (typeof ${constant})[number];`);
  } else if (hasBaseAlias(schema)) {
    const base = `_${name}Base`;
    const baseType = schema.oneOf
      ? renderUnion(schema.oneOf, schemas, false)
      : renderObject(schema, schemas);
    lines.push(`export type ${base} = ${baseType};`);
    lines.push("");
    lines.push(renderDiscriminatedType(name, schema, base));
  } else {
    lines.push(`export type ${name} = ${renderType(schema, schemas, false)};`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderBarrel(schemas: SchemaCatalog): string {
  const valueExports: string[] = [];
  const typeExports: string[] = [];
  for (const [name, schema] of schemas) {
    const path = `./models/${toKebabCase(name)}.ts`;
    if (isEnum(schema)) {
      valueExports.push(
        `export { ${toConstantCase(name)}_VALUES } from "${path}";`,
      );
    }
    const symbols = hasBaseAlias(schema) ? [`_${name}Base`, name] : [name];
    typeExports.push(`export type { ${symbols.join(", ")} } from "${path}";`);
  }
  return `${generatedHeader}\n\n${valueExports.join("\n")}\n\n${
    typeExports.join("\n")
  }\n`;
}

function renderDiscriminatedType(
  name: string,
  schema: OpenApiSchema,
  fallback: string,
): string {
  const discriminator = optionalRecord(schema.discriminator);
  const mapping = optionalRecord(discriminator?.mapping);
  if (!mapping || Object.keys(mapping).length === 0) {
    return `export type ${name} = ${fallback};`;
  }
  const property = requiredString(
    discriminator?.propertyName,
    `OpenAPI discriminator for '${name}' propertyName`,
  );
  const entries = Object.entries(mapping).map(([value, reference]) => ({
    type: referenceName(requiredString(reference, "discriminator mapping")),
    value,
  }));
  const discriminatorName = `${name}Discriminator`;
  const values = entries.map(({ value }) => renderLiteral(value)).join(" | ");
  const variants = entries
    .map(({ type, value }) =>
      `${JSON.stringify(value)}: { ${propertyName(property)}: ${
        renderLiteral(value)
      } } & ${type};`
    )
    .join("\n");
  return `type ${discriminatorName} = ${values};

export type ${name}<
  TType extends ${discriminatorName} = ${discriminatorName},
> = ${fallback} & ({
${variants}
})[TType];`;
}

function renderType(
  schema: OpenApiSchema,
  schemas: SchemaCatalog,
  preferBaseReference: boolean,
): string {
  let type: string;
  if (typeof schema.$ref === "string") {
    const name = referenceName(schema.$ref);
    type = referencedSymbol(name, schemas, preferBaseReference);
  } else if (Array.isArray(schema.oneOf)) {
    type = renderUnion(schema.oneOf, schemas, false);
  } else if (Array.isArray(schema.allOf)) {
    type = schema.allOf
      .map((part) => renderType(asRecord(part, "allOf schema"), schemas, true))
      .join(" & ");
  } else if (isEnum(schema)) {
    type = schema.enum.map(renderLiteral).join(" | ");
  } else {
    switch (schema.type) {
      case "string":
        type = "string";
        break;
      case "integer":
      case "number":
        type = "number";
        break;
      case "boolean":
        type = "boolean";
        break;
      case "array":
        type = `Array<${
          renderType(asRecord(schema.items, "array items"), schemas, false)
        }>`;
        break;
      case "object":
      case undefined:
        type = renderObject(schema, schemas);
        break;
      default:
        throw new Error(
          `Unsupported OpenAPI schema type '${String(schema.type)}'.`,
        );
    }
  }
  return schema.nullable === true ? `(${type}) | null` : type;
}

function renderUnion(
  candidates: unknown,
  schemas: SchemaCatalog,
  preferBaseReference: boolean,
): string {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("OpenAPI union must contain at least one schema.");
  }
  return candidates
    .map((candidate) =>
      renderType(
        asRecord(candidate, "union schema"),
        schemas,
        preferBaseReference,
      )
    )
    .join(" | ");
}

function renderObject(schema: OpenApiSchema, schemas: SchemaCatalog): string {
  const properties = optionalRecord(schema.properties) ?? {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.map((value) =>
        requiredString(value, "required property")
      )
      : [],
  );
  const members: string[] = [];
  for (const [name, property] of Object.entries(properties)) {
    const optional = required.has(name) ? "" : "?";
    members.push(
      `${propertyName(name)}${optional}: ${
        renderType(asRecord(property, `property '${name}'`), schemas, false)
      };`,
    );
  }
  if (schema.additionalProperties === true) {
    members.push("[key: string]: unknown;");
  } else if (
    schema.additionalProperties && schema.additionalProperties !== false
  ) {
    members.push(
      `[key: string]: ${
        renderType(
          asRecord(schema.additionalProperties, "additional properties"),
          schemas,
          false,
        )
      };`,
    );
  }
  return members.length === 0
    ? "Record<string, never>"
    : `{\n${members.join("\n")}\n}`;
}

function collectImports(
  schema: OpenApiSchema,
  schemas: SchemaCatalog,
  ownName: string,
): Map<string, Set<string>> {
  const symbols = new Set<string>();
  visitSchema(schema, schemas, false, symbols);
  symbols.delete(ownName);
  symbols.delete(`_${ownName}Base`);

  const imports = new Map<string, Set<string>>();
  for (const symbol of symbols) {
    const name = symbol.startsWith("_") && symbol.endsWith("Base")
      ? symbol.slice(1, -4)
      : symbol;
    const path = toKebabCase(name);
    const current = imports.get(path) ?? new Set<string>();
    current.add(symbol);
    imports.set(path, current);
  }
  return imports;
}

function visitSchema(
  schema: OpenApiSchema,
  schemas: SchemaCatalog,
  preferBaseReference: boolean,
  symbols: Set<string>,
): void {
  if (typeof schema.$ref === "string") {
    const name = referenceName(schema.$ref);
    symbols.add(referencedSymbol(name, schemas, preferBaseReference));
  }
  for (const key of ["oneOf", "allOf"] as const) {
    const candidates = schema[key];
    if (!Array.isArray(candidates)) continue;
    for (const candidate of candidates) {
      visitSchema(
        asRecord(candidate, `${key} schema`),
        schemas,
        key === "allOf",
        symbols,
      );
    }
  }
  const properties = optionalRecord(schema.properties);
  if (properties) {
    for (const property of Object.values(properties)) {
      visitSchema(
        asRecord(property, "property schema"),
        schemas,
        false,
        symbols,
      );
    }
  }
  if (schema.items) {
    visitSchema(asRecord(schema.items, "array items"), schemas, false, symbols);
  }
  if (schema.additionalProperties && schema.additionalProperties !== true) {
    visitSchema(
      asRecord(schema.additionalProperties, "additional properties"),
      schemas,
      false,
      symbols,
    );
  }
  const mapping = optionalRecord(optionalRecord(schema.discriminator)?.mapping);
  if (mapping) {
    for (const reference of Object.values(mapping)) {
      symbols.add(
        referenceName(requiredString(reference, "discriminator mapping")),
      );
    }
  }
}

function referencedSymbol(
  name: string,
  schemas: SchemaCatalog,
  preferBaseReference: boolean,
): string {
  const target = schemas.get(name);
  if (!target) throw new Error(`Unknown OpenAPI schema reference '${name}'.`);
  return preferBaseReference && hasBaseAlias(target) ? `_${name}Base` : name;
}

function hasBaseAlias(schema: OpenApiSchema): boolean {
  return optionalRecord(schema.discriminator) !== undefined &&
    (schema.type === "object" || Array.isArray(schema.oneOf));
}

function isEnum(
  schema: OpenApiSchema,
): schema is OpenApiSchema & { readonly enum: readonly unknown[] } {
  return Array.isArray(schema.enum) && schema.enum.length > 0;
}

function referenceName(reference: string): string {
  const match = /^#\/components\/schemas\/([^/]+)$/u.exec(reference);
  if (!match?.[1]) {
    throw new Error(`Unsupported OpenAPI reference '${reference}'.`);
  }
  return match[1];
}

function renderLiteral(value: unknown): string {
  if (
    typeof value !== "string" && typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw new Error(
      "OpenAPI enum values must be strings, numbers, or booleans.",
    );
  }
  return JSON.stringify(value);
}

function propertyName(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value)
    ? value
    : JSON.stringify(value);
}

function isTypeScriptIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value);
}

function toKebabCase(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase();
}

function toConstantCase(value: string): string {
  return toKebabCase(value).replaceAll("-", "_").toUpperCase();
}

function requiredString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} must be a non-empty string.`);
  }
  return value;
}

function optionalRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return value === undefined ? undefined : asRecord(value, "value");
}

function asRecord(
  value: unknown,
  context: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

if (import.meta.main) {
  const sourceDirectory = resolve(
    import.meta.dirname ?? Deno.cwd(),
    "../openapi",
  );
  const outputDirectory = resolve(
    import.meta.dirname ?? Deno.cwd(),
    "generated",
  );
  await generateApiModels(sourceDirectory, outputDirectory);
}
