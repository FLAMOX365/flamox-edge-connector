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

The image runs as the non-root `deno` user. `/data` is the only writable durable
volume. The two optional local trust files are customer-owned safety overlays;
an empty overlay denies managed extensions even when FLAMOX365 assigns them.

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
deno task extensions list
deno task extensions install-bundle extension.fmx grant.json configuration.json
deno task extensions reconfigure extension.id configuration.json grant.json
deno task extensions activate extension.id
deno task extensions disable extension.id
deno task extensions rollback extension.id
deno task extensions uninstall extension.id
```

These commands create `LOCAL` installations. FLAMOX365 Desired State manages
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
