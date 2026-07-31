# FLAMOX365 control-plane protocol

## Connection model

The managed connector uses outbound HTTPS polling. The configured management URL
is the FLAMOX365 API v1 root, for example `https://api.example.com/api/v1/`.
Production configuration requires HTTPS. HTTP is accepted only with the explicit
local-development override.

Pairing is the only unauthenticated protocol operation. Every subsequent request
uses:

```text
Authorization: EdgeConnector <connector-id>.<machine-secret>
```

The server hashes the machine secret and binds the connector record, public RSA
key and credential to one tenant. Revocation invalidates the credential.

## Pairing

```text
POST edge/connectors/pair
```

The request contains schema version 1, the one-time code, display name and a
public RSA-OAEP-256 JWK generated locally. The response returns connector id,
tenant id and the machine secret once. The connector stores the result and the
private RSA key in an owner-only identity file; neither is exposed by Desktop
state or operational logs.

## Desired and Observed State

```text
GET  edge/connectors/control/desired?afterRevision=<revision>
POST edge/connectors/control/observed
```

Desired State is a complete tenant-scoped projection containing:

- the monotonic revision;
- only publisher public keys required by assigned releases;
- the derived extension policy and exact grants;
- extension id, release version, same-origin artifact path, desired lifecycle
  state and JSON configuration;
- secrets individually encrypted to the connector RSA public key.

The connector verifies the contract, refreshes managed trust and policy, then
reconciles each extension through `ExtensionManager`. It downloads only from the
management origin, caps streamed response size, verifies the signed release and
reports a sanitized observation for every desired extension. The local cursor is
advanced only after a complete reconciliation and accepted observation.

Locally managed extensions have separate ownership. Desired State cannot replace
or remove them.

## Artifact download

```text
GET edge/connectors/control/artifacts/<release-id>
```

The cloud authorizes the release against an installation assigned to that exact
connector. The `.fmx` JSON bundle is content-addressed and still independently
validated by the connector: media type, paths, sizes, digest, manifest identity,
publisher key and Ed25519 signature must all match.

## Remote commands

```text
GET  edge/connectors/control/commands?afterSequence=<sequence>
POST edge/connectors/control/command-results
```

FLAMOX365 can enqueue only an action declared by a published release on an
active, observed tenant installation. Commands carry a monotonic sequence, UUID,
expiration and JSON input. The connector executes the exact extension/action
pair, reports `SUCCEEDED`, `FAILED` or `EXPIRED`, and persists its cursor only
after the result was accepted.

## Audit outbox

```text
POST edge/connectors/control/audit
```

Install, update, reconfigure, uninstall and action outcomes enter a durable
local outbox. Batches are acknowledged locally only after FLAMOX365 accepts
them. Event UUIDs are unique server-side, so replay after a crash is idempotent.
Audit data must remain non-secret.

## Failure and retry semantics

- The agent polls continuously and retains its last complete revision and
  command sequence in atomic owner-only state files.
- Failed extension candidates do not replace the active revision.
- One extension failure is reported without preventing observations for other
  extensions; the overall revision is not committed until reconciliation is
  complete.
- A failed cloud request leaves Desired State cursors and the audit outbox
  untouched for the next poll.
- Schema versions, revisions, sequences, UUIDs, statuses, payload sizes and
  response JSON are validated at the protocol boundary.

The original OAuth2 WebSocket transport remains available independently for
legacy Functions/YAML/proxy traffic.
