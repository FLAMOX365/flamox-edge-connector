# Desktop test app

The Tauri 2 application is an internal engineering and customer-test host. It
starts the same Node.js 26 backend as the service and preserves the existing
Runtime, Configuration, Extensions and Logs views.

## Start and build

Install Node.js from `.node-version`, Yarn 4.18.1, Rust 1.99.0 and the
[Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).
Then run:

```bash
yarn install --immutable
yarn desktop:dev
yarn desktop:build
```

The build type-checks/compiles TypeScript 7, packages production dependencies,
bundles the browser bridge and copies a standalone official Node sidecar.
`tools/node-runtime.ts` verifies the downloaded archive against the official
SHA-256 list and verifies its version. It does not ship a Homebrew binary with
machine-specific shared-library links. Native artifacts are written below
`desktop/src-tauri/target/release/bundle/`. Signing, notarization and publication
belong to the human release owner.

## Desktop boundary

The webview invokes a small allowlisted Rust command surface. Rust owns the
Node sidecar and exchanges bounded JSON messages over private process pipes;
there is no localhost administration server. The webview cannot invoke a shell,
launch arbitrary programs or choose a backend method outside the allowlist.
File/folder pickers and message dialogs use Tauri's native dialog plugin.
Extension message boxes remain capability-checked by the backend.

Backend state changes push an invalidation through Rust to the webview, which
reloads the affected desktop state. The UI does not poll. Local log entries,
connection changes and managed synchronization also invalidate the view. Closing
the app terminates the sidecar and its extension processes.

## Pairing and extension tools

The Configuration tab accepts the FLAMOX365 management URL, display name and
one-time pairing code. Pairing creates the local RSA identity, consumes the code
and clears it from the persisted settings. Tenant identity and installed
extension state remain visible while the listener is stopped; machine secrets
and identity private keys never enter desktop state.

The app can start/stop the connector, inspect logs, install/reconfigure/activate/
disable/rollback/uninstall a local bundle and execute declared actions. Publisher
tools generate an Ed25519 key pair, sign a package and produce `.fmx` bytes.
Private publisher keys are offered locally as downloads rather than persisted
in the desktop settings.

## Local data and validation

Settings retain the existing user-configuration location and owner-only writes.
Runtime identity and packages use the configured data directory. Stop the host
before changing paths or operating on the same data from another process.

For an isolated native run, use the executable with
`--settings /absolute/path/to/test-settings.json`; configure fresh data and
Functions directories in that file. This avoids loading an operator's real
identity during a UI check. The compiled-backend IPC test verifies persistence,
state invalidation, binary key transport and rejection of malformed operations.
The extension isolation prerequisites in [Installation](INSTALLATION.md) apply
to the desktop sidecar as well.

Native message dialogs belong to the Tauri main window. The Rust broker attaches
the dialog to that window and returns a failed display result if the window no
longer exists. This avoids an unowned background alert and keeps the response
on the private dialog channel. Verify a visible sheet and its successful action
result in an isolated native smoke run; IPC mocks alone do not prove visibility.
