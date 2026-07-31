import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  choosePath,
  createPathPickerCommands,
  parsePathPickerRequest,
  type PathPickerCommand,
} from "./path-picker.ts";

Deno.test("path picker validates directory and file requests", () => {
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

Deno.test("path picker keeps user values outside native command scripts", () => {
  const request = parsePathPickerRequest({
    kind: "file",
    title: 'Select "trusted" JSON',
    initialPath: "/tmp/customer path",
    extensions: ["json"],
  });

  const [mac] = createPathPickerCommands(request, "darwin");
  assertEquals(mac.command, "osascript");
  assertEquals(mac.args.slice(-3), [
    'Select "trusted" JSON',
    "/tmp/customer path",
    "json",
  ]);
  assertEquals(mac.args[1].includes("/tmp/customer path"), false);

  const [windows] = createPathPickerCommands(request, "windows");
  assertEquals(windows.command, "powershell.exe");
  assertEquals(
    windows.env?.FLAMOX_PICKER_INITIAL_PATH,
    "/tmp/customer path",
  );
  assertEquals(
    windows.args.some((arg) => arg.includes("/tmp/customer path")),
    false,
  );
});

Deno.test("path picker falls back to the available Linux dialog", async () => {
  const commands: PathPickerCommand[] = [];
  const result = await choosePath({
    kind: "directory",
    title: "Select Functions directory",
    initialPath: "/srv/functions",
  }, {
    os: "linux",
    run: (command) => {
      commands.push(command);
      if (command.command === "zenity") {
        throw new Deno.errors.NotFound("zenity is not installed");
      }
      return Promise.resolve({
        code: 0,
        stdout: "/srv/functions/customer\n",
        stderr: "",
      });
    },
  });

  assertEquals(commands.map((command) => command.command), [
    "zenity",
    "kdialog",
  ]);
  assertEquals(result, "/srv/functions/customer");
});

Deno.test("path picker treats native cancellation as an unchanged value", async () => {
  const result = await choosePath({
    kind: "directory",
    title: "Select data directory",
  }, {
    os: "darwin",
    run: () =>
      Promise.resolve({
        code: 1,
        stdout: "",
        stderr: "execution error: User canceled. (-128)",
      }),
  });
  assertEquals(result, null);
});

Deno.test("Linux path picker exposes directory mode and file filters", () => {
  const directory = createPathPickerCommands(
    parsePathPickerRequest({
      kind: "directory",
      title: "Data",
      initialPath: "/tmp/data/",
    }),
    "linux",
  );
  assertEquals(directory[0].args.includes("--directory"), true);
  assertStringIncludes(directory[0].args.join(" "), "--filename=/tmp/data/");

  const file = createPathPickerCommands(
    parsePathPickerRequest({
      kind: "file",
      title: "Policy",
      extensions: ["json"],
    }),
    "linux",
  );
  assertStringIncludes(file[0].args.join(" "), "*.json");
});
