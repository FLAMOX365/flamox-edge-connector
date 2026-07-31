// @ts-check
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference path="../contracts.ts" />

/** @type {import('../contracts.ts').DesktopState | null} */
let currentState = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastTimer;

/** @param {string} id */
const byId = (id) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element '${id}'.`);
  return element;
};

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((candidate) =>
      candidate.classList.toggle("active", candidate === tab)
    );
    document.querySelectorAll(".panel").forEach((panel) =>
      panel.classList.toggle(
        "active",
        panel.id === `panel-${tab.getAttribute("data-tab")}`,
      )
    );
  })
);

document.querySelectorAll("button[data-path-picker]").forEach((button) => {
  if (!(button instanceof HTMLButtonElement)) return;
  button.addEventListener("click", () => pickPath(button));
});

byId("refresh").addEventListener("click", refresh);
byId("refresh-extensions").addEventListener("click", refresh);
byId("refresh-logs").addEventListener("click", refresh);
byId("start").addEventListener(
  "click",
  () => mutate(() => bindings.startConnector(), "Connector started."),
);
byId("stop").addEventListener(
  "click",
  () => mutate(() => bindings.stopConnector(), "Connector stopped."),
);
byId("clear-logs").addEventListener(
  "click",
  () => mutate(() => bindings.clearLogs(), "Logs cleared."),
);
byId("cancel-action").addEventListener(
  "click",
  () => byId("action-form").classList.add("hidden"),
);
byId("connect-managed").addEventListener("click", async () => {
  await mutate(
    () => bindings.connectManaged(settingsFromForm()),
    "Connector paired and managed runtime started.",
  );
});

byId("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await mutate(
    () => bindings.saveSettings(settingsFromForm()),
    "Configuration saved.",
  );
});

byId("install-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = /** @type {HTMLInputElement} */ (byId("bundle-file")).files?.[0];
  if (!file) return showToast("Choose an extension bundle.", true);
  const input = {
    bytes: new Uint8Array(await file.arrayBuffer()),
    grant: parseJson(
      /** @type {HTMLTextAreaElement} */ (byId("bundle-grant")).value,
      "grant",
    ),
    configuration: parseJson(
      /** @type {HTMLTextAreaElement} */ (byId("bundle-configuration")).value,
      "configuration",
    ),
    activate: /** @type {HTMLInputElement} */ (byId("bundle-active")).checked,
  };
  await mutate(() => bindings.installBundle(input), "Extension installed.");
});

byId("publisher-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const publisher = /** @type {HTMLInputElement} */ (byId("publisher-name"))
      .value;
    const keyId = /** @type {HTMLInputElement} */ (byId("publisher-key-id"))
      .value;
    const output = await bindings.generatePublisherKey(publisher, keyId);
    download(output.privateKey, `${keyId}.private.jwk`, "application/json");
    download(output.trust, `${keyId}.trust.json`, "application/json");
    showToast("Publisher key generated locally.");
  } catch (error) {
    showError(error);
  }
});

byId("sign-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const file = /** @type {HTMLInputElement} */ (byId("sign-private-key"))
      .files?.[0];
    if (!file) return showToast("Choose a private publisher key.", true);
    const source = /** @type {HTMLInputElement} */ (byId("sign-directory"))
      .value;
    const keyId = /** @type {HTMLInputElement} */ (byId("sign-key-id")).value;
    const bytes = await bindings.signExtension(
      source,
      new Uint8Array(await file.arrayBuffer()),
      keyId,
    );
    const release = parseJson(new TextDecoder().decode(bytes), "release");
    download(
      bytes,
      `${release.extensionId ?? "extension"}-${
        release.version ?? "release"
      }.release.json`,
      "application/json",
    );
    showToast("Extension release signed locally.");
  } catch (error) {
    showError(error);
  }
});

byId("pack-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const source =
      /** @type {HTMLInputElement} */ (byId("pack-directory")).value;
    const release = parseJson(
      /** @type {HTMLTextAreaElement} */ (byId("pack-release")).value,
      "release",
    );
    const bytes = await bindings.packExtension(source, release);
    download(
      bytes,
      `${release.extensionId ?? "extension"}-${
        release.version ?? "release"
      }.fmx`,
      "application/vnd.flamox.edge-extension+json",
    );
    showToast("Extension bundle packed.");
  } catch (error) {
    showError(error);
  }
});

byId("action-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const output = await bindings.executeAction({
      extensionId:
        /** @type {HTMLInputElement} */ (byId("action-extension")).value,
      action: /** @type {HTMLInputElement} */ (byId("action-name")).value,
      input: /** @type {import('../contracts.ts').JsonValue} */ (parseJson(
        /** @type {HTMLTextAreaElement} */ (byId("action-input")).value,
        "action input",
      )),
    });
    byId("action-output").textContent = JSON.stringify(output, null, 2);
  } catch (error) {
    showError(error);
  }
});

async function refresh() {
  try {
    render(await bindings.getState());
  } catch (error) {
    showError(error);
  }
}

/** @param {HTMLButtonElement} button */
async function pickPath(button) {
  const target = button.dataset.pathTarget;
  const kind = button.dataset.pathKind;
  if (!target || (kind !== "directory" && kind !== "file")) {
    return showToast("Path picker configuration is invalid.", true);
  }
  const input = byId(target);
  if (!(input instanceof HTMLInputElement)) {
    return showToast("Path picker target is invalid.", true);
  }

  button.disabled = true;
  try {
    const selected = await bindings.choosePath({
      kind,
      title: button.dataset.pathTitle ??
        (kind === "directory" ? "Choose directory" : "Choose file"),
      initialPath: input.value,
      extensions: (button.dataset.pathExtensions ?? "")
        .split(",")
        .map((extension) => extension.trim())
        .filter(Boolean),
    });
    if (selected === null) return;
    input.value = selected;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.focus();
    showToast(kind === "directory" ? "Directory selected." : "File selected.");
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
}

/** @param {() => Promise<import('../contracts.ts').DesktopState>} action @param {string} message */
async function mutate(action, message) {
  setBusy(true);
  try {
    render(await action());
    showToast(message);
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
}

/** @param {import('../contracts.ts').DesktopState} state */
function render(state) {
  currentState = state;
  byId("runtime-label").textContent = state.running ? "Running" : "Stopped";
  byId("runtime-dot").classList.toggle("online", state.running);
  byId("connection-state").textContent = state.status?.connectionState ?? "—";
  byId("last-connected").textContent = state.status?.lastConnectedAt
    ? new Date(state.status.lastConnectedAt).toLocaleString()
    : "—";
  byId("reconnect-attempt").textContent = String(
    state.status?.reconnectAttempt ?? 0,
  );
  byId("extension-count").textContent = String(state.extensions.length);
  const managed = state.managedConnection;
  byId("pairing-state").textContent = managed
    ? state.running ? "Paired · running" : "Paired · stopped"
    : "Not paired";
  byId("pairing-state").classList.toggle("error", !managed && state.running);
  byId("connector-id").textContent = managed?.connectorId ?? "—";
  byId("tenant-id").textContent = managed?.tenantId ?? "—";
  byId("desired-revision").textContent = String(managed?.desiredRevision ?? 0);
  byId("last-sync").textContent = managed?.lastSuccessfulSyncAt
    ? new Date(managed.lastSuccessfulSyncAt).toLocaleString()
    : "—";
  byId("managed-error").textContent = managed?.lastErrorMessage ?? "";
  byId("managed-error").classList.toggle("hidden", !managed?.lastErrorMessage);
  /** @type {HTMLButtonElement} */ (byId("start")).disabled = state.running;
  /** @type {HTMLButtonElement} */ (byId("stop")).disabled = !state.running;
  /** @type {HTMLButtonElement} */ (byId("settings-form").querySelector(
    'button[type="submit"]',
  )).disabled = state.running;
  fillSettings(state.settings);
  renderExtensions(state.extensions);
  renderLogs(state.logs);
}

/** @returns {import('../contracts.ts').DesktopSettings} */
function settingsFromForm() {
  const form = /** @type {HTMLFormElement} */ (byId("settings-form"));
  const data = new FormData(form);
  /** @type {Record<string, string | number | boolean>} */
  const settings = Object.fromEntries(
    [...data.entries()].map(([key, value]) => [key, String(value)]),
  );
  settings.bindPort = Number(settings.bindPort);
  settings.allowInsecureConnections =
    data.get("allowInsecureConnections") === "on";
  return /** @type {import('../contracts.ts').DesktopSettings} */ (
    /** @type {unknown} */ (settings)
  );
}

/** @param {import('../contracts.ts').DesktopSettings} settings */
function fillSettings(settings) {
  const form = /** @type {HTMLFormElement} */ (byId("settings-form"));
  for (const [key, value] of Object.entries(settings)) {
    const control =
      /** @type {HTMLInputElement | HTMLSelectElement | null} */ (form.elements
        .namedItem(key));
    if (!control || document.activeElement === control) continue;
    if (control instanceof HTMLInputElement && control.type === "checkbox") {
      control.checked = value === true;
    } else control.value = String(value);
  }
}

/** @param {readonly unknown[]} extensions */
function renderExtensions(extensions) {
  const list = byId("extensions-list");
  list.replaceChildren();
  if (extensions.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "No extensions installed.";
    list.append(empty);
    return;
  }
  for (const value of extensions) {
    const extension = /** @type {Record<string, unknown>} */ (value);
    const row = document.createElement("article");
    row.className = "extension";
    const details = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${extension.extensionId} · ${extension.version}`;
    const status = document.createElement("span");
    status.className = `status ${extension.status === "ERROR" ? "error" : ""}`;
    status.textContent = String(extension.status);
    const meta = document.createElement("small");
    meta.textContent = `${extension.managementMode} · installed ${
      new Date(String(extension.installedAt)).toLocaleString()
    }`;
    details.append(title, status, meta);
    const actions = document.createElement("div");
    actions.className = "button-row";
    actions.append(
      actionButton(
        extension.status === "ACTIVE" ? "Disable" : "Activate",
        () =>
          mutate(
            () =>
              extension.status === "ACTIVE"
                ? bindings.disableExtension(String(extension.extensionId))
                : bindings.activateExtension(String(extension.extensionId)),
            "Extension state changed.",
          ),
      ),
      actionButton(
        "Reconfigure",
        () => reconfigure(String(extension.extensionId), extension),
      ),
      actionButton(
        "Run action",
        () => openAction(String(extension.extensionId)),
      ),
      actionButton(
        "Rollback",
        () =>
          mutate(
            () => bindings.rollbackExtension(String(extension.extensionId)),
            "Extension rolled back.",
          ),
      ),
      actionButton(
        "Uninstall",
        () =>
          mutate(
            () => bindings.uninstallExtension(String(extension.extensionId)),
            "Extension uninstalled.",
          ),
        "danger",
      ),
    );
    row.append(details, actions);
    list.append(row);
  }
}

/** @param {string} extensionId @param {Record<string, unknown>} extension */
function reconfigure(extensionId, extension) {
  const configuration = prompt(
    "Configuration JSON",
    JSON.stringify(extension.configuration ?? {}, null, 2),
  );
  if (configuration === null) return;
  const grant = prompt(
    "Grant JSON",
    JSON.stringify(extension.grant ?? {}, null, 2),
  );
  if (grant === null) return;
  mutate(
    () =>
      bindings.reconfigureExtension(
        extensionId,
        parseJson(configuration, "configuration"),
        parseJson(grant, "grant"),
      ),
    "Extension reconfigured.",
  );
}

/** @param {string} label @param {() => void} callback @param {string=} className */
function actionButton(label, callback, className) {
  const button = document.createElement("button");
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener("click", callback);
  return button;
}

/** @param {string} extensionId */
function openAction(extensionId) {
  /** @type {HTMLInputElement} */ (byId("action-extension")).value =
    extensionId;
  byId("action-title").textContent = `Run action on ${extensionId}`;
  byId("action-output").textContent = "";
  byId("action-form").classList.remove("hidden");
  byId("action-form").scrollIntoView({ behavior: "smooth" });
}

/** @param {readonly import('../contracts.ts').DesktopLogEntry[]} logs */
function renderLogs(logs) {
  const container = byId("logs");
  container.replaceChildren();
  for (const entry of logs) {
    const row = document.createElement("div");
    row.className = `log ${entry.level}`;
    for (
      const text of [
        new Date(entry.at).toLocaleString(),
        entry.level.toUpperCase(),
        entry.message,
      ]
    ) {
      const span = document.createElement("span");
      span.textContent = text;
      row.append(span);
    }
    container.append(row);
  }
  container.scrollTop = container.scrollHeight;
}

/** @param {string} value @param {string} label @returns {Record<string, unknown>} */
function parseJson(value, label) {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

/** @param {Uint8Array} bytes @param {string} filename @param {string} type */
function download(bytes, filename, type) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}
/** @param {boolean} value */
function setBusy(value) {
  document.querySelectorAll("button").forEach((button) =>
    button.disabled = value
  );
  if (!value && currentState) render(currentState);
}
/** @param {unknown} error */
function showError(error) {
  const message = error && typeof error === "object" && "message" in error
    ? String(error.message)
    : String(error);
  byId("runtime-error").textContent = message;
  byId("runtime-error").classList.remove("hidden");
  showToast(message, true);
}
/** @param {string} message @param {boolean=} error */
function showToast(message, error = false) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 4000);
}

await refresh();
setInterval(() => {
  if (currentState?.running) refresh();
}, 2000);
