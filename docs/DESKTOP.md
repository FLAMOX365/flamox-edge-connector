# Desktop test app

The Deno Desktop project is an internal engineering and customer-test host. It
is not the customer production distribution; production uses the service or
container.

## Start and build

```bash
deno task desktop:dev
deno task desktop:build
```

The build task creates the platform artifact configured in `desktop/deno.json`.
On macOS this is `desktop/dist/Edge Connector Desktop.app`.

## Authentication assistance

The Configuration tab collects the FLAMOX365 management URL, connector display
name and one-time pairing code. **Save & pair connector** persists validated
settings, creates the local RSA identity, consumes the code and starts managed
reconciliation. After success the code is removed from Desktop settings.

The Runtime tab displays connector id, tenant id, persisted Desired State
revision, last live synchronization and any managed error. Tenant pairing and
installed extension state remain visible while the listener is stopped. No
machine secret or private key is returned through the browser binding.

## Native path selection

Every configuration value that requires an operating-system path has a
**Browse…** action. Data, Functions/YAML and customer package locations open a
native directory chooser. Trusted-publisher and extension-policy settings open a
native JSON file chooser. Existing `.fmx` and private-key uploads continue to
use the webview's native file input because their bytes, rather than their local
paths, are passed to the runtime.

Deno Desktop 2.9 does not yet expose a first-class file or folder dialog API.
The Desktop backend therefore owns a narrow platform adapter that invokes only
the native picker on macOS or Windows. Linux uses `zenity` and falls back to
`kdialog`; one of those tools must be installed. Picker titles, initial paths
and extension filters are passed as arguments or environment values rather than
interpolated into executable scripts.

## Runtime and extension testing

The app starts the exact same host as the service binary, including listener,
Functions/YAML watcher, legacy WebSocket and managed agent. It can:

- start, stop and refresh the runtime;
- inspect logs and connection state;
- show installed version, `LOCAL`/`MANAGED` ownership and lifecycle state;
- install a local `.fmx`, reconfigure, activate, disable, rollback or uninstall;
- invoke a declared action and inspect JSON output;
- generate an Ed25519 publisher key pair, sign a package and pack `.fmx`.

Private publisher keys are generated locally and offered as a file download.
They are not saved into Desktop settings.

## Local data

Desktop settings default to the user's configuration directory and are written
with owner-only permissions. Runtime identity, extension state and packages live
under the separately configured data directory. Stop the runtime before changing
those directories or operating on the same data with the CLI.
