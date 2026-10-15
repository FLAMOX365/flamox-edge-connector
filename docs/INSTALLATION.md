# Installation and operations

## Customer deployment

The customer deployment is the service/container, not the internal Desktop app.
The connector needs outbound HTTPS to FLAMOX365 and outbound access only to the
network targets granted to installed extensions. No inbound cloud-to-DMZ port is
required.

```bash
cd templates/starter
cp .env.example .env
mkdir -p config
cp ../../config/extension-policy.example.json config/extension-policy.json
cp ../../config/trusted-publishers.example.json config/trusted-publishers.json
docker compose up --build -d
```

The image runs as the non-root `node` user. `/data` is the only writable durable
volume. The two optional local trust files are customer-owned safety overlays;
an empty overlay denies managed extensions even when FLAMOX365 assigns them.

## Extension isolation prerequisites

Use Node.js 26.12.0 (`.node-version`), Yarn 4.18.1 and the locked TypeScript 7
compiler. For a source service: `yarn install --immutable`, `yarn build`, then
`yarn start`. TypeScript files are compiled before service startup. Node's
native type stripping is used only for erasable build-tool scripts; operator
Functions use an ESM loader with esbuild to retain enums and parameter properties.

| Host | Required isolation support |
| --- | --- |
| macOS | Built-in `sandbox-exec`; Xcode command-line tools for linked-library discovery. The desktop sidecar uses the official standalone Node archive. |
| Linux | `bubblewrap`, `socat`, and working unprivileged user/PID/network namespaces. AppArmor must permit those operations for the sandbox binaries. |
| Windows | One elevated `yarn exec srt windows-install` from the installed checkout provisions the sandbox account and WFP fence. Upstream support is alpha. |

Do not run the Windows provisioning command on every service start: it changes
machine policy and rotates the sandbox account password. Missing prerequisites
produce an extension activation error. The connector never relaxes enforcement
or executes the package without isolation.

The container installs Linux prerequisites and runs as `node`. Its host's
seccomp/AppArmor profile must also allow the required nested namespaces. A
successful image build is not proof that extension execution works under the
operator's container policy. Run the isolation tests on the intended Linux
host before deploying; do not default to a privileged container.

## Replacing a historical runtime

The manifest schema remains version 2; new packages declare
`runtime.kind: "node-process"`. A signature covers this value and the compiled
ESM bytes. Rebuild and re-sign extensions; never edit an existing signed bundle
or reuse an immutable published release version.

FLAMOX365 accepts historical `deno-worker` metadata for existing releases and
installations, but accepts only `node-process` for newly uploaded artifacts.
The Node connector refuses to execute historical packages. At startup an old
active installation becomes `ERROR` / `EXTENSION_RESTORE_FAILED`; its package,
configuration, identity and history are retained. Select an explicitly rebuilt
Node release to recover. A rollback target must also be a Node release.

Coordinate backend, connector and extension rollout. Before replacing the
service, stop it and back up the complete data directory. A runtime downgrade
requires the matching runtime-compatible release/state snapshot; a package
signature alone does not make it executable by both runtimes. Human owners
publish versions and deployments separately from this source migration.

## First pairing

Create a pairing code in FLAMOX365, then put these values into the deployment
secret configuration for the first start:

```text
EDGE_CONNECTOR_MANAGEMENT_URL=https://api.example.com/api/v1/
EDGE_CONNECTOR_PAIRING_CODE=edge_...
EDGE_CONNECTOR_DISPLAY_NAME=Customer DMZ 1
```

After the identity file exists, remove `EDGE_CONNECTOR_PAIRING_CODE`. Keep the
data volume: deleting `data/identity/connector.json` loses the tenant-bound
device identity and requires a new connector registration.

## Environment variables

| Variable                                    | Default          | Purpose                                                       |
| ------------------------------------------- | ---------------- | ------------------------------------------------------------- |
| `EDGE_CONNECTOR_BIND_HOST`                  | `0.0.0.0`        | Local health and compatible `/ws` listener                    |
| `EDGE_CONNECTOR_BIND_PORT`                  | `8080`           | Listener port                                                 |
| `EDGE_CONNECTOR_DATA_DIRECTORY`             | `data`           | Identity, cursors, audit, packages and process lock           |
| `EDGE_CONNECTOR_FUNCTIONS_DIR`              | `functions`      | Retained TypeScript/JavaScript/YAML function directory        |
| `EDGE_CONNECTOR_MANAGEMENT_URL`             | unset            | FLAMOX365 API v1 root for pairing and managed polling         |
| `EDGE_CONNECTOR_PAIRING_CODE`               | unset            | One-time first-pairing code                                   |
| `EDGE_CONNECTOR_DISPLAY_NAME`               | `Edge Connector` | Connector name shown in FLAMOX365                             |
| `EDGE_CONNECTOR_MANAGEMENT_POLL_SECONDS`    | `5`              | Managed reconciliation interval                               |
| `EDGE_CONNECTOR_EXTENSION_POLICY_FILE`      | unset            | Optional local allow policy; unset denies local installations |
| `EDGE_CONNECTOR_TRUSTED_PUBLISHERS_FILE`    | unset            | Optional locally trusted Ed25519 publishers                   |
| `EDGE_CONNECTOR_WS_URL`                     | unset            | Retained outbound legacy WebSocket URL                        |
| `EDGE_CONNECTOR_CONTROL_PLANE_URL`          | unset            | Retained OAuth discovery root                                 |
| `EDGE_CONNECTOR_TOKEN_ENDPOINT`             | unset            | Retained direct OAuth token endpoint                          |
| `EDGE_CONNECTOR_CLIENT_ID`                  | unset            | Retained OAuth client id                                      |
| `EDGE_CONNECTOR_CLIENT_SECRET`              | unset            | Retained OAuth client secret                                  |
| `EDGE_CONNECTOR_ALLOW_INSECURE_CONNECTIONS` | `false`          | Allows HTTP/WS only for isolated local testing                |
| `EDGE_CONNECTOR_LOG_LEVEL`                  | `info`           | `error`, `warn`, `info` or `debug`                            |

Heartbeat, reconnect, timeout, jitter and liveness tuning variables remain
available and are validated in `runtime/config.ts`.

## Health

- `GET /health` is process liveness and fails only when supervision is stale.
- `GET /ready` represents the retained WebSocket transport. With no legacy
  WebSocket configured, it is ready.
- Managed synchronization, tenant id, revision and errors are visible in
  FLAMOX365 and in the internal Desktop app.

## Local and offline lifecycle

Stop the service before using the offline CLI; the data-directory lock prevents
concurrent mutation.

```bash
yarn extensions list
yarn extensions install-bundle extension.fmx grant.json configuration.json
yarn extensions reconfigure extension.id configuration.json grant.json
yarn extensions activate extension.id
yarn extensions disable extension.id
yarn extensions rollback extension.id
yarn extensions uninstall extension.id
```

These commands target `LOCAL` installations. The current host also checks the
managed policy before the local overlay; without a managed rule, even an
otherwise locally authorized offline installation is rejected. This existing
limitation is tracked in [CR-0549](https://github.com/RueDeRennes/flamox/issues/653). FLAMOX365 Desired State manages
only `MANAGED` installations and cannot take over a local extension with the
same id.

## Backup and update

- Stop the process before backing up or restoring the complete data directory.
- Preserve the identity, extension state, control cursor and audit outbox
  together.
- Update the connector binary/container without rewriting the data volume.
- Keep customer firewall rules, local publisher trust and local policy under
  change control.
- Revoke a lost or compromised connector in FLAMOX365 before pairing a
  replacement.
- Never place credentials in extension configuration; use declared secrets.
