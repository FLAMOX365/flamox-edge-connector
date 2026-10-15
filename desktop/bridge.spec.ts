import { test } from "node:test";
import assert from "node:assert/strict";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { DesktopBindings } from "./contracts.ts";

test("Tauri webview bindings preserve the private transport, binary data, dialogs and push events", async (t) => {
  const events = new EventTarget();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDispatch = Object.getOwnPropertyDescriptor(
    globalThis,
    "dispatchEvent",
  );
  Object.defineProperty(globalThis, "window", {
    value: globalThis,
    configurable: true,
  });
  Object.defineProperty(globalThis, "dispatchEvent", {
    value: events.dispatchEvent.bind(events),
    configurable: true,
  });
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  let result: unknown = null,
    rejected = false;
  mockIPC(
    (command, payload) => {
      calls.push({ command, args: payload as Record<string, unknown> });
      if (rejected) throw new Error("Desktop operation denied");
      return result;
    },
    { shouldMockEvents: true },
  );
  t.after(() => {
    clearMocks();
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalDispatch)
      Object.defineProperty(globalThis, "dispatchEvent", originalDispatch);
    else Reflect.deleteProperty(globalThis, "dispatchEvent");
  });
  await import("./bridge.ts");
  const bindings: DesktopBindings = (
    globalThis as unknown as { bindings: DesktopBindings }
  ).bindings;
  await t.test(
    "extension commands retain resource identity and arguments through the Rust allowlist",
    async () => {
      result = { accepted: true };
      assert.deepEqual(
        await bindings.executeAction({
          extensionId: "test.extension",
          action: "inspect",
          input: { count: 2 },
        }),
        result,
      );
      assert.deepEqual(calls.at(-1), {
        command: "connector_request",
        args: {
          method: "executeAction",
          args: [
            {
              extensionId: "test.extension",
              action: "inspect",
              input: { count: 2 },
            },
          ],
        },
      });
      await bindings.rollbackExtension("test.extension", "1.0.0");
      assert.deepEqual(calls.at(-1)!.args, {
        method: "rollbackExtension",
        args: ["test.extension", "1.0.0"],
      });
    },
  );
  await t.test(
    "bundle upload and signing preserve bytes across base64 chunk boundaries",
    async () => {
      const bytes = Uint8Array.from(
        { length: 24_579 },
        (_, index) => index % 256,
      );
      result = { running: false };
      await bindings.installBundle({
        bytes,
        configuration: { mode: "test" },
        grant: {},
        activate: true,
      });
      const upload = (calls.at(-1)!.args.args as { bytes: string }[])[0]!;
      assert.deepEqual(
        new Uint8Array(Buffer.from(upload.bytes, "base64")),
        bytes,
      );
      result = {
        encoding: "base64",
        data: Buffer.from(bytes).toString("base64"),
      };
      assert.deepEqual(
        await bindings.signExtension("/fixture/source", bytes, "fixture-key"),
        bytes,
      );
      assert.equal(
        (calls.at(-1)!.args.args as unknown[])[1],
        Buffer.from(bytes).toString("base64"),
      );
      assert.deepEqual(
        await bindings.packExtension("/fixture/source", {}),
        bytes,
      );
    },
  );
  await t.test(
    "publisher keys decode independently and unsupported binary encodings fail",
    async () => {
      result = {
        privateKey: { encoding: "base64", data: "AP8=" },
        trust: { encoding: "base64", data: "e30=" },
      };
      assert.deepEqual(
        await bindings.generatePublisherKey("FLAMOX365", "fixture-key"),
        {
          privateKey: new Uint8Array([0, 255]),
          trust: new Uint8Array([123, 125]),
        },
      );
      result = { encoding: "hex", data: "00ff" };
      await assert.rejects(
        () => bindings.packExtension("/fixture/source", {}),
        /Unsupported binary response/,
      );
    },
  );
  await t.test(
    "native path selection preserves filters and cancellation without invoking connector mutations",
    async () => {
      result = "/fixture/extension.fmx";
      assert.equal(
        await bindings.choosePath({
          kind: "file",
          title: "Fixture",
          initialPath: "/fixture",
          extensions: ["fmx"],
        }),
        "/fixture/extension.fmx",
      );
      assert.deepEqual(calls.at(-1), {
        command: "plugin:dialog|open",
        args: {
          options: {
            directory: false,
            multiple: false,
            title: "Fixture",
            defaultPath: "/fixture",
            filters: [{ name: "fmx", extensions: ["fmx"] }],
          },
        },
      });
      result = null;
      assert.equal(
        await bindings.choosePath({
          kind: "directory",
          title: "Fixture",
          initialPath: "",
          extensions: [],
        }),
        null,
      );
    },
  );
  await t.test(
    "server-pushed invalidations become view events and transport failures propagate",
    async () => {
      let invalidations = 0;
      events.addEventListener("connector-state-changed", () => invalidations++);
      await emit("connector-state-changed");
      assert.equal(invalidations, 1);
      rejected = true;
      await assert.rejects(
        () => bindings.getState(),
        /Desktop operation denied/,
      );
      rejected = false;
    },
  );
});
