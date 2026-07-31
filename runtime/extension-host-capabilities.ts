import type {
  JsonValue,
  ShowMessageRequest,
  ShowMessageResult,
} from "../sdk/extension.ts";
import { RuntimeError } from "./runtime-error.ts";

export const SHOW_MESSAGE_CAPABILITY = "host.ui.message-box";
export const SHOW_MESSAGE_OPERATION = "show-message";

export type ExtensionHostCall = {
  readonly extensionId: string;
  readonly requestId: string;
  readonly capability: string;
  readonly operation: string;
  readonly input: JsonValue;
};

export interface ExtensionHostCapabilityProvider {
  invoke(call: ExtensionHostCall): Promise<JsonValue>;
}

export class DenyAllExtensionHostCapabilityProvider
  implements ExtensionHostCapabilityProvider {
  invoke(call: ExtensionHostCall): Promise<JsonValue> {
    return Promise.reject(
      new RuntimeError(
        "HOST_CAPABILITY_UNAVAILABLE",
        `Host capability '${call.capability}' is unavailable.`,
      ),
    );
  }
}

export interface MessageBoxAdapter {
  show(request: ShowMessageRequest): Promise<void>;
}

/** Exposes only explicitly implemented interactive UI operations. */
export class InteractiveExtensionHostCapabilityProvider
  implements ExtensionHostCapabilityProvider {
  constructor(private readonly messageBox: MessageBoxAdapter) {}

  async invoke(call: ExtensionHostCall): Promise<JsonValue> {
    if (
      call.capability !== SHOW_MESSAGE_CAPABILITY ||
      call.operation !== SHOW_MESSAGE_OPERATION
    ) {
      throw new RuntimeError(
        "HOST_CAPABILITY_NOT_SUPPORTED",
        `Host operation '${call.capability}/${call.operation}' is not supported.`,
      );
    }
    const request = parseShowMessageRequest(call.input);
    await this.messageBox.show(request);
    return { displayed: true } satisfies ShowMessageResult;
  }
}

export class NativeMessageBoxAdapter implements MessageBoxAdapter {
  async show(request: ShowMessageRequest): Promise<void> {
    const normalized = parseShowMessageRequest(request as unknown as JsonValue);
    switch (Deno.build.os) {
      case "darwin":
        await runMacOsMessageBox(normalized);
        return;
      case "windows":
        await runWindowsMessageBox(normalized);
        return;
      case "linux":
        await runLinuxMessageBox(normalized);
        return;
      default:
        throw new RuntimeError(
          "HOST_UI_NOT_SUPPORTED",
          `Native message boxes are not supported on '${Deno.build.os}'.`,
        );
    }
  }
}

export function parseShowMessageRequest(value: JsonValue): ShowMessageRequest {
  if (!isRecord(value)) {
    invalidMessageBox();
  }
  const keys = Object.keys(value);
  if (
    keys.some((key) => !["title", "message", "kind"].includes(key)) ||
    typeof value.title !== "string" ||
    typeof value.message !== "string" ||
    (value.kind !== undefined &&
      value.kind !== "info" &&
      value.kind !== "warning" &&
      value.kind !== "error")
  ) {
    invalidMessageBox();
  }
  const title = value.title.trim();
  const message = value.message.trim();
  if (
    title.length === 0 || title.length > 200 ||
    message.length === 0 || message.length > 4_000
  ) {
    invalidMessageBox();
  }
  return {
    title,
    message,
    kind: value.kind ?? "info",
  };
}

async function runMacOsMessageBox(request: ShowMessageRequest): Promise<void> {
  const script = [
    "on run argv",
    'display dialog (item 2 of argv) with title (item 1 of argv) buttons {"OK"} default button "OK"',
    "end run",
  ].join("\n");
  await runCommand(
    "osascript",
    ["-e", script, request.title, request.message],
  );
}

async function runWindowsMessageBox(
  request: ShowMessageRequest,
): Promise<void> {
  const script = [
    "Add-Type -AssemblyName PresentationFramework",
    "$icon = switch ($args[2]) {",
    "  'warning' { 'Warning' }",
    "  'error' { 'Error' }",
    "  default { 'Information' }",
    "}",
    "[System.Windows.MessageBox]::Show($args[1], $args[0], 'OK', $icon) | Out-Null",
  ].join("; ");
  let missing: unknown;
  for (const executable of ["powershell.exe", "pwsh"]) {
    try {
      await runCommand(executable, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
        request.title,
        request.message,
        request.kind ?? "info",
      ]);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      missing = error;
    }
  }
  throw new RuntimeError(
    "HOST_UI_NOT_SUPPORTED",
    "No supported PowerShell executable is available.",
    { cause: missing },
  );
}

async function runLinuxMessageBox(request: ShowMessageRequest): Promise<void> {
  try {
    await runCommand("zenity", [
      request.kind === "error"
        ? "--error"
        : request.kind === "warning"
        ? "--warning"
        : "--info",
      `--title=${request.title}`,
      `--text=${request.message}`,
    ]);
    return;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  try {
    await runCommand("kdialog", [
      request.kind === "error"
        ? "--error"
        : request.kind === "warning"
        ? "--sorry"
        : "--msgbox",
      request.message,
      "--title",
      request.title,
    ]);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    throw new RuntimeError(
      "HOST_UI_NOT_SUPPORTED",
      "Neither zenity nor kdialog is installed.",
      { cause: error },
    );
  }
}

async function runCommand(
  executable: string,
  args: readonly string[],
): Promise<void> {
  const output = await new Deno.Command(executable, {
    args: [...args],
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!output.success) {
    const detail = new TextDecoder().decode(output.stderr).trim();
    throw new RuntimeError(
      "HOST_UI_FAILED",
      detail || `Native message box exited with code ${output.code}.`,
    );
  }
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidMessageBox(): never {
  throw new RuntimeError(
    "INVALID_HOST_CAPABILITY_INPUT",
    "Message box input must contain a title, message and optional kind.",
  );
}
