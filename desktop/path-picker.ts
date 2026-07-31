export type PathPickerKind = "directory" | "file";
export type PathPickerOs = typeof Deno.build.os;

export type PathPickerRequest = {
  readonly kind: PathPickerKind;
  readonly title: string;
  readonly initialPath: string;
  readonly extensions: readonly string[];
};

export type PathPickerCommand = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
};

export type PathPickerCommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type PathPickerCommandRunner = (
  command: PathPickerCommand,
) => Promise<PathPickerCommandResult>;

export type PathPickerOptions = {
  readonly os?: PathPickerOs;
  readonly run?: PathPickerCommandRunner;
};

const maximumPathLength = 16_384;
const maximumTitleLength = 240;
const maximumExtensions = 24;

const macDirectoryScript = `
on run argv
  set dialogTitle to item 1 of argv
  set startingPath to item 2 of argv
  if startingPath is "" then
    set selectedItem to choose folder with prompt dialogTitle
  else
    try
      set selectedItem to choose folder with prompt dialogTitle default location (POSIX file startingPath)
    on error errorMessage number errorNumber
      if errorNumber is -128 then error errorMessage number errorNumber
      set selectedItem to choose folder with prompt dialogTitle
    end try
  end if
  return POSIX path of selectedItem
end run
`;

const macFileScript = `
on run argv
  set dialogTitle to item 1 of argv
  set startingPath to item 2 of argv
  set extensionsCsv to item 3 of argv
  set allowedTypes to {}
  if extensionsCsv is not "" then
    set previousDelimiters to AppleScript's text item delimiters
    set AppleScript's text item delimiters to ","
    set allowedTypes to text items of extensionsCsv
    set AppleScript's text item delimiters to previousDelimiters
  end if

  if startingPath is "" then
    if (count of allowedTypes) is 0 then
      set selectedItem to choose file with prompt dialogTitle
    else
      set selectedItem to choose file with prompt dialogTitle of type allowedTypes
    end if
  else
    try
      if (count of allowedTypes) is 0 then
        set selectedItem to choose file with prompt dialogTitle default location (POSIX file startingPath)
      else
        set selectedItem to choose file with prompt dialogTitle of type allowedTypes default location (POSIX file startingPath)
      end if
    on error errorMessage number errorNumber
      if errorNumber is -128 then error errorMessage number errorNumber
      if (count of allowedTypes) is 0 then
        set selectedItem to choose file with prompt dialogTitle
      else
        set selectedItem to choose file with prompt dialogTitle of type allowedTypes
      end if
    end try
  end if
  return POSIX path of selectedItem
end run
`;

const windowsDirectoryScript = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = [Environment]::GetEnvironmentVariable('FLAMOX_PICKER_TITLE')
$initial = [Environment]::GetEnvironmentVariable('FLAMOX_PICKER_INITIAL_PATH')
if ($initial) { $dialog.SelectedPath = $initial }
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
`;

const windowsFileScript = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = [Environment]::GetEnvironmentVariable('FLAMOX_PICKER_TITLE')
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
$dialog.RestoreDirectory = $true
$initial = [Environment]::GetEnvironmentVariable('FLAMOX_PICKER_INITIAL_PATH')
if ($initial) { $dialog.InitialDirectory = $initial }
$extensions = [Environment]::GetEnvironmentVariable('FLAMOX_PICKER_EXTENSIONS')
if ($extensions) {
  $patterns = ($extensions -split ',') | ForEach-Object { "*.$_" }
  $dialog.Filter = "Allowed files|$($patterns -join ';')|All files|*.*"
} else {
  $dialog.Filter = "All files|*.*"
}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.FileName)
}
`;

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

export function createPathPickerCommands(
  request: PathPickerRequest,
  os: PathPickerOs = Deno.build.os,
): readonly PathPickerCommand[] {
  switch (os) {
    case "darwin":
      return [{
        command: "osascript",
        args: [
          "-e",
          request.kind === "directory" ? macDirectoryScript : macFileScript,
          request.title,
          request.initialPath,
          request.extensions.join(","),
        ],
      }];
    case "windows": {
      const env = pickerEnvironment(request);
      const script = request.kind === "directory"
        ? windowsDirectoryScript
        : windowsFileScript;
      return ["powershell.exe", "pwsh"].map((command) => ({
        command,
        args: ["-NoProfile", "-NonInteractive", "-Sta", "-Command", script],
        env,
      }));
    }
    case "linux":
      return linuxCommands(request);
    default:
      throw new Error(`Native path selection is not supported on '${os}'.`);
  }
}

export async function choosePath(
  value: unknown,
  options: PathPickerOptions = {},
): Promise<string | null> {
  const request = parsePathPickerRequest(value);
  const commands = createPathPickerCommands(request, options.os);
  const run = options.run ?? runCommand;
  let availableCommandFound = false;

  for (const command of commands) {
    let result: PathPickerCommandResult;
    try {
      result = await run(command);
      availableCommandFound = true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }

    if (result.code === 0) return selectedPath(result.stdout);
    if (isCancellation(result)) return null;
    throw new Error(commandFailure(command, result));
  }

  if (!availableCommandFound) {
    throw new Error(
      "No native path picker is available. Install zenity or kdialog on Linux.",
    );
  }
  return null;
}

function linuxCommands(
  request: PathPickerRequest,
): readonly PathPickerCommand[] {
  const zenityArgs = [
    "--file-selection",
    `--title=${request.title}`,
  ];
  if (request.kind === "directory") zenityArgs.push("--directory");
  if (request.initialPath) {
    zenityArgs.push(`--filename=${request.initialPath}`);
  }
  if (request.kind === "file" && request.extensions.length > 0) {
    const patterns = request.extensions.map((extension) => `*.${extension}`);
    zenityArgs.push(`--file-filter=Allowed files | ${patterns.join(" ")}`);
    zenityArgs.push("--file-filter=All files | *");
  }

  const kdialogArgs = request.kind === "directory"
    ? ["--getexistingdirectory", request.initialPath || ".", request.title]
    : [
      "--getopenfilename",
      request.initialPath || ".",
      fileFilter(request.extensions),
      request.title,
    ];

  return [
    { command: "zenity", args: zenityArgs },
    { command: "kdialog", args: kdialogArgs },
  ];
}

function fileFilter(extensions: readonly string[]): string {
  if (extensions.length === 0) return "*|All files";
  return `${
    extensions.map((extension) => `*.${extension}`).join(" ")
  }|Allowed files\n*|All files`;
}

function pickerEnvironment(
  request: PathPickerRequest,
): Readonly<Record<string, string>> {
  return {
    FLAMOX_PICKER_TITLE: request.title,
    FLAMOX_PICKER_INITIAL_PATH: request.initialPath,
    FLAMOX_PICKER_EXTENSIONS: request.extensions.join(","),
  };
}

async function runCommand(
  command: PathPickerCommand,
): Promise<PathPickerCommandResult> {
  const output = await new Deno.Command(command.command, {
    args: [...command.args],
    env: command.env ? { ...command.env } : undefined,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

function selectedPath(stdout: string): string | null {
  const value = stdout.replace(/[\r\n]+$/u, "");
  if (!value) return null;
  if (value.length > maximumPathLength || value.includes("\0")) {
    throw new Error("The selected path is invalid.");
  }
  return value;
}

function isCancellation(result: PathPickerCommandResult): boolean {
  if (result.code !== 1) return false;
  const stderr = result.stderr.trim().toLowerCase();
  return stderr === "" ||
    stderr.includes("user canceled") ||
    stderr.includes("user cancelled") ||
    stderr.includes("(-128)");
}

function commandFailure(
  command: PathPickerCommand,
  result: PathPickerCommandResult,
): string {
  const detail = result.stderr.trim();
  return detail
    ? `Native path picker '${command.command}' failed: ${detail}`
    : `Native path picker '${command.command}' exited with code ${result.code}.`;
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
