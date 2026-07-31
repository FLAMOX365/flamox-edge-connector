# Edge Connector

[![CI](https://github.com/FLAMOX365/flamox-edge-connector/actions/workflows/ci.yml/badge.svg)](https://github.com/FLAMOX365/flamox-edge-connector/actions/workflows/ci.yml)

Edge Connector is a standalone Deno service for a customer-controlled network or
DMZ. It preserves the complete Functions, YAML, proxy, SDK and WebSocket
behavior of the proven upstream connector and adds a managed, tenant-bound
Extension Store runtime on top.

The connector initiates every cloud connection outbound. FLAMOX365 can pair it
to exactly one tenant, publish Desired State, deliver encrypted secrets, install
or reconfigure signed extensions, invoke declared actions and receive Observed
State, command results and durable operational audit events.

## Implemented capabilities

- TypeScript/JavaScript Functions, YAML functions, HTTP proxy mode, hot reload,
  inbound `/ws` compatibility and the resilient OAuth2 outbound WebSocket.
- One-time connector pairing with a locally generated RSA identity and a
  tenant-bound machine credential.
- Monotonic Desired/Observed State reconciliation, restart-safe cursors and
  remote install, update, reconfigure, activate, disable and uninstall.
- `.fmx` Store bundles, deterministic SHA-256 digests, Ed25519 publisher
  signatures, same-origin bounded downloads and atomic rollback.
- Customer-authored extensions through the retained SDK and a self-contained
  extension starter.
- JSON Schema configuration, explicit least-privilege grants, scoped encrypted
  secret delivery and exact network permission enforcement.
- Durable remote command results and idempotent audit delivery.
- An internal Deno Desktop app for pairing, native path selection, listener
  control, status, extensions, local execution and publisher tooling.

No FRITZ!Box implementation is bundled yet. FRITZ!Box/FritzFon is now an
ordinary Store extension and no connector or cloud architecture needs to be
reopened to add it.

## Run and verify

Prerequisite: Deno 2.9.4 or newer.

```bash
deno task check
deno task lint
deno task test
deno task audit
deno task verify:generated
deno task start
```

The default listener is `127.0.0.1:8080` outside the container. `GET /health`
reports process liveness and `GET /ready` reports legacy WebSocket readiness.
The managed FLAMOX365 protocol is outbound polling and does not add a public
local administration endpoint.

## Managed pairing

1. In FLAMOX365, create a one-time pairing code under organization settings.
2. Configure `EDGE_CONNECTOR_MANAGEMENT_URL` with the FLAMOX365 API v1 root and
   provide `EDGE_CONNECTOR_PAIRING_CODE` for the first start only.
3. The connector generates an RSA-OAEP-256 key pair, consumes the code and
   stores its identity at `data/identity/connector.json` with owner-only
   permissions.
4. Remove the pairing code. Subsequent starts authenticate with the persisted
   tenant-bound device credential.

The internal Desktop app guides the same flow and removes the one-time code from
its settings after successful pairing:

```bash
deno task desktop:dev
deno task desktop:build
```

See [Desktop test app](docs/DESKTOP.md).

## Extension development workflow

```bash
deno task extension -- init ../my-extension
deno task extension -- dev ../my-extension --once \
  --input-file ../my-extension/examples/show-message.json
deno task extension -- publish ../my-extension
```

`init` asks for identity, publisher, version and optional FLAMOX365 Cloud
connection, creates a complete project, runs its tests and produces a signed
`.fmx`. `publish` registers the public publisher key and catalog metadata with
FLAMOX365 before uploading the immutable artifact as a draft. The private
publisher key never enters FLAMOX365 or the connector. See
[Extension authoring](docs/EXTENSION_AUTHORING.md).

## Architecture

```text
FLAMOX365 tenant / platform settings
  -> Extension Store metadata and publisher trust in PostgreSQL
  -> immutable .fmx artifact in the configured blob service
  -> Desired State + RSA-encrypted secrets + declared action commands
  -> outbound authenticated HTTPS polling
  -> connector reconciler
  -> ExtensionManager
     -> signature + digest + manifest + schema + local-policy verification
     -> candidate health + atomic activation / rollback
     -> isolated Deno worker with exact read/network/secret grants
  -> Observed State + command result + durable audit outbox
```

The managed extension path is additive. Legacy Functions/YAML/proxy requests
continue through their original executor; exact
`/extensions/{extensionId}/actions/{action}` requests are dispatched to the
managed extension runtime.

## Repository layout

```text
runtime/   Service host, legacy transports, control plane and extension runtime
sdk/       Retained customer Functions SDK and extension contracts
cli/       Extension project wizard, development, packaging and Cloud upload
desktop/   Internal Deno Desktop pairing and test application
schemas/   Manifest, release, policy and publisher schemas
templates/ Service starter, legacy examples and extension starter
docs/      Deployment, protocol, security and extension authoring
```

## Documentation

- [Installation and operations](docs/INSTALLATION.md)
- [Control-plane protocol](docs/CONTROL_PLANE_INTEGRATION.md)
- [Extension authoring](docs/EXTENSION_AUTHORING.md)
- [Desktop test app](docs/DESKTOP.md)
- [Security model](docs/SECURITY.md)
- [Future protocol families](docs/FUTURE_PROTOCOLS.md)

## License and origin

This repository retains the MIT-licensed upstream implementation and its
copyright notice in [LICENSE](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md)
before proposing a change, [SUPPORT.md](SUPPORT.md) for support requests, and
[the security policy](docs/SECURITY.md) for private vulnerability reporting.
