/// <reference lib="deno.unstable" />

import type { ExecuteActionInput, InstallBundleInput } from "./contracts.ts";
import { DesktopConnectorController } from "./controller.ts";
import { choosePath } from "./path-picker.ts";

const controller = await DesktopConnectorController.create();
const window = new Deno.BrowserWindow({
  title: "Edge Connector Desktop",
  width: 1_280,
  height: 860,
});

window.bind("getState", () => Promise.resolve(controller.state()));
window.bind("choosePath", (request) => choosePath(request));
window.bind(
  "saveSettings",
  (settings) => controller.saveSettings(settings),
);
window.bind(
  "connectManaged",
  (settings) => controller.connect(settings),
);
window.bind("startConnector", () => controller.start());
window.bind("stopConnector", () => controller.stop());
window.bind(
  "installBundle",
  (input) => controller.installBundle(input as unknown as InstallBundleInput),
);
window.bind(
  "reconfigureExtension",
  (id, configuration, grant) =>
    controller.reconfigure(textArgument(id), configuration, grant),
);
window.bind(
  "activateExtension",
  (id) => controller.activate(textArgument(id)),
);
window.bind(
  "disableExtension",
  (id) => controller.disable(textArgument(id)),
);
window.bind(
  "rollbackExtension",
  (id, version) =>
    controller.rollback(textArgument(id), optionalTextArgument(version)),
);
window.bind(
  "uninstallExtension",
  (id) => controller.uninstall(textArgument(id)),
);
window.bind(
  "executeAction",
  (input) => controller.execute(input as unknown as ExecuteActionInput),
);
window.bind(
  "digestExtension",
  (source) => controller.digest(textArgument(source)),
);
window.bind(
  "generatePublisherKey",
  (publisher, keyId) =>
    controller.generatePublisher(textArgument(publisher), textArgument(keyId)),
);
window.bind(
  "signExtension",
  (source, privateKey, keyId) =>
    controller.sign(
      textArgument(source),
      privateKey as Uint8Array,
      textArgument(keyId),
    ),
);
window.bind(
  "packExtension",
  (source, release) => controller.pack(textArgument(source), release),
);
window.bind("clearLogs", () => Promise.resolve(controller.clearLogs()));

window.addEventListener("close", () => {
  controller.stop().finally(() => Deno.exit(0));
});

const assets = new Map<
  string,
  { readonly file: string; readonly contentType: string }
>([
  ["/", { file: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/app.js", {
    file: "app.js",
    contentType: "text/javascript; charset=utf-8",
  }],
  ["/styles.css", {
    file: "styles.css",
    contentType: "text/css; charset=utf-8",
  }],
]);

Deno.serve(async (request) => {
  const url = new URL(request.url);
  const asset = assets.get(url.pathname);
  if (!asset) return new Response("Not found", { status: 404 });
  return new Response(
    await Deno.readFile(new URL(`./ui/${asset.file}`, import.meta.url)),
    {
      headers: {
        "content-type": asset.contentType,
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
        "x-content-type-options": "nosniff",
      },
    },
  );
});

function textArgument(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a text argument.");
  return value;
}

function optionalTextArgument(value: unknown): string | undefined {
  return value === undefined || value === null
    ? undefined
    : textArgument(value);
}
