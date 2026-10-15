# Extension authoring and publication

## Install or run the Extension CLI

Run the CLI directly from the Edge Connector checkout:

```bash
yarn extension help
```

For the compiled CLI, build once and invoke Node.js directly:

```bash
yarn build
node dist/cli/main.js help
```

The `extension` examples below refer to `yarn extension` from this checkout.
Node.js 26 executes the service, TypeScript 7 type-checks and compiles projects,
and esbuild creates the offline ESM extension artifact.

## Guided initialization

The interactive wizard is the default project entry point:

```bash
extension init ./extensions/my-extension
```

It asks for extension id, display name, description, publisher, semantic
version, publisher key id and the optional FLAMOX365 Cloud URL. It then creates:

- the strict `extension-manifest.json`;
- a locked SDK package and typed ESM entrypoint;
- configuration and UI schemas;
- German and English translation resources;
- the exact local development grant;
- example action input and automated tests;
- Yarn tasks, ignore rules and project documentation.

The wizard validates the complete manifest and local import graph, starts the
isolated process, runs the tests, builds a clean `dist` tree, creates an Ed25519
publisher identity when needed and writes a signed `.fmx` artifact. The
non-interactive equivalent for automation is:

```bash
extension init ./extensions/my-extension --yes \
  --id my-extension \
  --name "My Extension" \
  --description "Performs the customer-specific operation." \
  --publisher "Customer GmbH" \
  --version 1.0.0 \
  --key-id customer-2026
```

Use `--area telephony` for a provider that implements the versioned telephony
contract. The generated project declares the required contribution and
capabilities and uses typed `startCall`, `endCall`, `synchronizeCalls`, and
`health` handlers:

```bash
extension init ./extensions/my-telephony-provider --yes \
  --id my-telephony-provider \
  --name "My Telephony Provider" \
  --publisher "Customer GmbH" \
  --version 1.0.0 \
  --area telephony \
  --key-id customer-2026
```

Use `extension create` only when scaffolding without the complete test/package
workflow is intentional. The retained `templates/extension` directory and
`yarn extensions` operator commands remain available for compatibility.

## Manifest contract

The signed `extension-manifest.json` declares:

- stable extension id, publisher and semantic version;
- `runtime.kind: "node-process"` and a local ESM entrypoint;
- capabilities and exact static/configured network needs;
- uppercase secret names;
- declared actions, timeout, idempotency and optional health action;
- optional action-owned input and output schemas;
- optional versioned area contributions with canonical operation contracts;
- optional configuration/UI schema and translation files.

Configuration is non-secret JSON. The Store derives an exact least-privilege
grant from the manifest and validated configuration. Unknown capabilities,
network targets or secrets are rejected.

Manifest schema version 2 validates action inputs before any secret resolution
or process execution and validates action outputs before returning them. An area
contribution owns its operation schemas; an extension cannot replace those
schemas with weaker action-local contracts.

Sign and pack the compiled `dist` package, rather than a folder of uncompiled
TypeScript sources. The Desktop publisher tools also expect this compiled
package directory.

Runtime dependencies are npm packages declared in `package.json` and resolved
through a checked-in `yarn.lock`. The scaffold references the SDK package from
the connector checkout used to create it; use a pinned source checkout when
sharing the project. In the extensions catalog this source is the pinned Git
submodule. Run `yarn install` when dependencies change. URL/JSR imports and
runtime downloads of executable code are unsupported.

`extension build` type-checks with TypeScript 7, bundles the complete dependency
graph for Node.js 26 into `runtime/extension.mjs`, and starts that artifact in the
same sandbox used for installation. The installed extension needs no package
manager, transpiler or online dependency resolver. Native addons and subprocesses
are unavailable. HTTP clients use the authenticated per-extension proxy;
native TCP drivers must use `connectTcp` from `@edge-connector/sdk/tcp` rather
than opening direct sockets. The SQL Server reference uses this with Tedious.

An extension may place exactly one Store-card image at its project root. Name it
`store-image.png`, `store-image.jpg`, `store-image.jpeg` or `store-image.webp`
and keep it at or below 2 MiB. Validation checks that the file matches its
declared type, and `extension build` copies it into the package so its bytes are
covered by the FMX signature. Store images remain optional.

## Development, test and bundle

```bash
extension dev ./extensions/my-extension \
  --input-file ./extensions/my-extension/examples/show-message.json
extension test ./extensions/my-extension
extension build ./extensions/my-extension
extension pack ./extensions/my-extension
```

`dev` watches the project unless `--once` is supplied. It executes the same
bundled module that is placed in the `.fmx`. Host functions such as a native
message box remain brokered by the Edge Connector; the isolated process never
receives process, FFI or unrestricted filesystem permissions.

Publisher private keys live with owner-only permissions below the local CLI
configuration directory and outside extension repositories. The corresponding
public trust document is safe to register with FLAMOX365.

The signature covers domain separator, extension id, version, deterministic
package digest, publisher and key id. Any file, manifest or metadata change
requires a new signature and normally a new version.

## Upload to FLAMOX365

Configure the Cloud target once. `system` uses the platform Extension Store;
`tenant` creates a tenant-private extension:

```bash
extension cloud configure \
  --url https://cloud.example.com \
  --scope system
extension login --token "$EDGE_EXTENSION_CLOUD_TOKEN"
extension publish ./extensions/my-extension
```

The access token must carry the matching Extension Store write permission.
Instead of persisting it, set `EDGE_EXTENSION_CLOUD_TOKEN` for the publishing
process. Publishing automatically upserts the catalog metadata, registers the
public Ed25519 key and uploads the signed `.fmx` as a draft through the existing
FLAMOX365 APIs.

FLAMOX365 stores manifest, schemas, translations, release descriptor, digest,
size, status and blob reference in PostgreSQL. The `.fmx` bytes themselves are
stored through the configured blob service. The Edge Connector later downloads
the authorized artifact from FLAMOX365; there is no separate Registry service.

## Install and configure

In FLAMOX365 choose a paired connector and published release. The dynamic form
is generated from the signed configuration and UI schemas. Secret values are
write-only and encrypted at rest in FLAMOX365, then encrypted again to the
target connector in Desired State.

Reconfiguration uses the same schema and grant checks as first installation. An
update is staged and health-checked before it replaces an active process. The
previous verified revision remains available for rollback.

## Local development

Use the Desktop app or the offline CLI with explicit trust, policy, grant and
configuration. A local installation has `LOCAL` ownership and is never silently
converted into a remotely managed installation.
