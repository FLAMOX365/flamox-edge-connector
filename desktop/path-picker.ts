export type PathPickerKind = "directory" | "file";
export type PathPickerRequest = {
  readonly kind: PathPickerKind;
  readonly title: string;
  readonly initialPath: string;
  readonly extensions: readonly string[];
};

const maximumPathLength = 16_384;
const maximumTitleLength = 240;
const maximumExtensions = 24;

export function parsePathPickerRequest(value: unknown): PathPickerRequest {
  if (!isRecord(value)) throw new Error("Path picker request is invalid.");
  const kind = value.kind;
  if (kind !== "directory" && kind !== "file") {
    throw new Error("Path picker kind must be 'directory' or 'file'.");
  }
  const title = optionalText(
    value.title,
    defaultTitle(kind),
    maximumTitleLength,
  );
  const initialPath = optionalText(value.initialPath, "", maximumPathLength);
  const extensions = parseExtensions(value.extensions);
  if (kind === "directory" && extensions.length > 0) {
    throw new Error("Directory pickers cannot filter file extensions.");
  }
  return { kind, title, initialPath, extensions };
}

function parseExtensions(value: unknown): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximumExtensions) {
    throw new Error("Path picker extensions are invalid.");
  }
  return value.map((extension) => {
    if (
      typeof extension !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,31}$/iu.test(extension)
    ) {
      throw new Error("Path picker extension is invalid.");
    }
    return extension.toLowerCase();
  });
}

function optionalText(
  value: unknown,
  fallback: string,
  maximumLength: number,
): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (
    typeof value !== "string" ||
    value.length > maximumLength ||
    value.includes("\0")
  ) {
    throw new Error("Path picker text is invalid.");
  }
  return value;
}

function defaultTitle(kind: PathPickerKind): string {
  return kind === "directory" ? "Choose directory" : "Choose file";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
