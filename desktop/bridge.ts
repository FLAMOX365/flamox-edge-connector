import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { parsePathPickerRequest } from "./path-picker.ts";
import type { DesktopBindings, DesktopState, JsonValue } from "./contracts.ts";

type EncodedBytes = { readonly encoding: "base64"; readonly data: string };
const call = <T>(method: string, ...args: unknown[]): Promise<T> =>
  invoke<T>("connector_request", { method, args });
const bindings: DesktopBindings = {
  getState: () => call<DesktopState>("getState"),
  choosePath: async (value) => {
    const request = parsePathPickerRequest(value);
    return await open({
      directory: request.kind === "directory",
      multiple: false,
      title: request.title,
      defaultPath: request.initialPath || undefined,
      filters: request.extensions.length
        ? [
            {
              name: request.extensions.join(", "),
              extensions: [...request.extensions],
            },
          ]
        : undefined,
    });
  },
  saveSettings: (settings) => call<DesktopState>("saveSettings", settings),
  connectManaged: (settings) => call<DesktopState>("connectManaged", settings),
  startConnector: () => call<DesktopState>("startConnector"),
  stopConnector: () => call<DesktopState>("stopConnector"),
  installBundle: (input) =>
    call<DesktopState>("installBundle", {
      ...input,
      bytes: encodeBytes(input.bytes),
    }),
  reconfigureExtension: (id, configuration, grant) =>
    call<DesktopState>("reconfigureExtension", id, configuration, grant),
  activateExtension: (id) => call<DesktopState>("activateExtension", id),
  disableExtension: (id) => call<DesktopState>("disableExtension", id),
  rollbackExtension: (id, version) =>
    call<DesktopState>("rollbackExtension", id, version),
  uninstallExtension: (id) => call<DesktopState>("uninstallExtension", id),
  executeAction: (input) => call<JsonValue>("executeAction", input),
  digestExtension: (source) => call<string>("digestExtension", source),
  generatePublisherKey: async (publisher, keyId) => {
    const result = await call<{
      privateKey: EncodedBytes;
      trust: EncodedBytes;
    }>("generatePublisherKey", publisher, keyId);
    return {
      privateKey: decodeBytes(result.privateKey),
      trust: decodeBytes(result.trust),
    };
  },
  signExtension: async (source, key, keyId) =>
    decodeBytes(
      await call<EncodedBytes>(
        "signExtension",
        source,
        encodeBytes(key),
        keyId,
      ),
    ),
  packExtension: async (source, release) =>
    decodeBytes(await call<EncodedBytes>("packExtension", source, release)),
  clearLogs: () => call<DesktopState>("clearLogs"),
};
Object.defineProperty(globalThis, "bindings", { value: bindings });
await listen("connector-state-changed", () =>
  globalThis.dispatchEvent(new Event("connector-state-changed")),
);

function encodeBytes(bytes: Uint8Array): string {
  const encoded: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 24_576)
    encoded.push(
      btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24_576))),
    );
  return encoded.join("");
}
function decodeBytes(value: EncodedBytes): Uint8Array {
  if (value.encoding !== "base64")
    throw new Error("Unsupported binary response.");
  return Uint8Array.from(atob(value.data), (character) =>
    character.charCodeAt(0),
  );
}
