import { test } from "node:test";
import { assertEquals, assertThrows } from "../test/assert.ts";
import { parsePathPickerRequest } from "./path-picker.ts";

test("path picker validates directory and file requests", () => {
  assertEquals(
    parsePathPickerRequest({
      kind: "directory",
      title: "Select runtime data",
      initialPath: "/var/lib/connector",
    }),
    {
      kind: "directory",
      title: "Select runtime data",
      initialPath: "/var/lib/connector",
      extensions: [],
    },
  );

  assertEquals(
    parsePathPickerRequest({
      kind: "file",
      title: "Select policy",
      extensions: ["JSON"],
    }).extensions,
    ["json"],
  );

  assertThrows(
    () =>
      parsePathPickerRequest({
        kind: "directory",
        extensions: ["json"],
      }),
    Error,
    "cannot filter",
  );
  assertThrows(
    () =>
      parsePathPickerRequest({
        kind: "file",
        extensions: ["../../secret"],
      }),
    Error,
    "extension is invalid",
  );
});
