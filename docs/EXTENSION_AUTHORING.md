# Extension authoring and publication

## Install or run the Extension CLI

Run the CLI directly from the Edge Connector checkout:

```bash
deno task extension -- help
```

To create a standalone executable named `extension`:

```bash
deno task extension:compile
./cli/dist/extension help
```

## Guided initialization

The interactive wizard is the default project entry point:

```bash
extension init ./extensions/my-extension
```

It asks for extension id, display name, description, publisher, semantic
version, publisher key id and the optional FLAMOX365 Cloud URL. It then creates:

- the strict `extension-manifest.json`;
- a commit-pinned SDK dependency and typed worker entrypoint;
- configuration and UI schemas;
- German and English translation resources;
- the exact local development grant;
- example action input and automated tests;
- Deno tasks, ignore rules and project documentation.

The wizard validates the complete manifest and local import graph, starts the
isolated worker, runs the tests, builds a clean `dist` tree, creates an Ed25519
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
`deno task extensions` operator commands remain available for compatibility.

## Manifest contract

The signed `extension-manifest.json` declares:

- stable extension id, publisher and semantic version;
- Deno worker entrypoint;
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
or worker execution and validates action outputs before returning them. An area
contribution owns its operation schemas; an extension cannot replace those
schemas with weaker action-local contracts.

Runtime dependencies are declared in `deno.json` and resolved through the
checked-in `deno.lock`. The Edge Connector SDK is referenced from a specific
commit of the Edge Connector GitHub repository; extension projects do not copy
its source. JSR, npm and commit-pinned HTTPS dependencies are allowed during
development and packaging. `extension build` bundles the complete graph into a
single local worker module, so installed extensions never fetch executable code
from the internet.

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
message box remain brokered by the Edge Connector; the isolated worker never
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
update is staged and health-checked before it replaces an active worker. The
previous verified revision remains available for rollback.

## Local development

Use the Desktop app or the offline CLI with explicit trust, policy, grant and
configuration. A local installation has `LOCAL` ownership and is never silently
converted into a remotely managed installation.
