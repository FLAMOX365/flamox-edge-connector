# Regression verification

Use the pinned Node.js version and an installed OS sandbox. On macOS use the
**official standalone Node distribution**; a dynamically linked Homebrew binary
can require relative native-library paths that the sandbox deliberately refuses.
See [installation prerequisites](INSTALLATION.md#extension-isolation-prerequisites).

```bash
yarn install --immutable
yarn check
yarn lint
yarn fmt
yarn test:coverage
yarn check:templates
yarn verify:generated
yarn test:native
yarn desktop:build --no-bundle
yarn audit
```

`yarn test` runs the same JavaScript/TypeScript scenarios without a coverage
report. `test:native` prepares the actual sidecar/resources and uses the Rust
version pinned in `desktop/src-tauri/rust-toolchain.toml`. It needs the native
Tauri build prerequisites. All three CI operating systems execute these gates;
the dependency audit remains a failing gate when an advisory is unresolved.

## What the tests prove

| Boundary | Behavioral evidence |
| --- | --- |
| Extension isolation | Real sandbox processes: own-file reads; denied foreign reads, writes, subprocesses and parent secrets; scoped secrets and concurrent contexts; exact network ports, redirect denial, direct-socket denial, separate extension policies and authenticated SOCKS TCP. |
| Process lifecycle and IPC | Signed action sets; input/output schemas without coercion; non-JSON output; execution/startup deadlines; concurrency and host-call limits; malformed and oversized frames; cancellation, late replies and fresh-process recovery. |
| Installation and updates | Digest/signature/policy checks, install/execute/reconfigure/disable/activate/uninstall, rollback and failed candidate health. Real signed HTTP bundles pass through reconciliation and preserve the old active package after a rejected candidate. Historical Deno packages retain their files/configuration and cannot execute on Node. |
| Cloud synchronization | Persisted desired/command cursors, observed-state acknowledgement, expired/denied commands, stable command IDs across delivery retries, bounded durable audit pages and no acknowledgement after failed delivery. A lost command-result acknowledgement can repeat execution; actions must preserve their existing idempotency contract. |
| Desktop | Compiled Node sidecar through private pipes: settings persistence, serialized commands, invalid input without disk mutation, push events, signed managed installation, binary keys and dialog replies. The webview adapter uses Tauri's official IPC mocks for base64 chunk boundaries, cancellation and push translation. Rust tests cover protocol parsing, command validation, reply correlation and shutdown. A native smoke check must also confirm the real window-attached message sheet, successful action result, health/readiness and clean stop. |
| Existing Functions/proxy | HTTP/WS listeners, binary frames, rejected upgrade routes, abort shutdown, TypeScript loading, filesystem-triggered route reload/deletion, YAML transformations, routing, upstream requests, token/reconnection and health behavior. |
| CLI and SDK | Scaffold, typecheck, actual independent project test execution, build, sign, pack, declared host capabilities, HTTP helpers and TCP denial without an authenticated proxy. A deliberately failing scaffold test must make `extension test` fail. |

The CLI negative test intentionally prints a failing **nested** test. The outer
regression suite passes only when the CLI propagates that failure. Read the final
outer summary, not an isolated nested log line.

The source coverage report includes unexecuted source files and excludes specs,
generated models and declarations. It is a diagnostic map, not evidence that
every branch or device works. Compiled sidecars and bundled guests run in separate
processes and do not necessarily map to their original TypeScript lines. Native
Rust tests and the compiled-package integration results are separate evidence.

## Extension catalog and backend

In the extensions checkout, run `yarn test:coverage`, `yarn check`, `yarn lint`,
`yarn fmt`, `yarn validate`, `yarn build` and `yarn audit` after
`yarn prepare:connector` and `yarn install --immutable`. The shared HTTP, WebDAV,
IPP, JSON and XML suites run through the root test target. The catalog integration
suite builds each discovered project with the pinned CLI and executes every
manifest action in the real sandbox against disposable local protocol fixtures.
A new manifest action requires a matching executable scenario.

The SQL scenario proves that bundled Tedious reaches TDS pre-login through the
SDK SOCKS adapter and reports connection failure correctly. It does **not** prove
successful authentication, query results or SQL Server compatibility. The local
TR-064 and SQL fixtures reserve `127.0.0.1:49000` and `127.0.0.1:14330`; other HTTP
fixtures use ephemeral ports. Tests must fail if these fixture ports are occupied.

In the FLAMOX365 checkout, generate Prisma and run the resolved
`backend-feature-edge:lint`, `backend-feature-edge:typecheck` and
`backend-feature-edge:test` targets. Those tests protect Node-only new imports,
historical metadata, signed artifact tampering, cleanup after rejected imports,
read failures without file/database mutation, grants, authentication and control
contracts. This is focused verification of the Edge feature.

## Qualification still required

Run the CI matrix on Linux, macOS and Windows; a local macOS pass does not qualify
the other platforms. Windows sandbox support remains upstream alpha. Container
execution needs a Docker host with the required namespace policy.

Before a rollout, separately verify real SQL Server credentials/TLS/rows, the
intended FRITZ!Box firmware, physical printers, NAS/WebDAV behavior and desktop
packaging on each target OS. Local protocol fixtures cannot establish those
vendor/device guarantees. Preserve isolated settings, identities and fake keys
for native desktop checks; never start tests with a customer's default settings.
