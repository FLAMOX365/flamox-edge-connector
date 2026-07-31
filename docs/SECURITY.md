# Security model

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability and do not include
credentials, private configuration, customer data, or exploit details in public
discussion. Submit a private report through
[GitHub private vulnerability reporting](https://github.com/FLAMOX365/flamox-edge-connector/security/advisories/new).
If that channel is temporarily unavailable, contact a repository maintainer
through an established private professional channel before sharing details.

No generally available release has been declared yet. Until the first release,
security fixes are applied to the `main` branch; no support commitment is made
for arbitrary snapshots.

## Trust boundaries

The customer controls the connector host, optional local trust and policy
overlays, operating-system permissions and network firewall. FLAMOX365 controls
the tenant-scoped Desired State and Store distribution. Cloud policy can narrow
local authority but cannot expand a configured local overlay.

An extension becomes executable only after strict manifest parsing, safe bundle
path and size checks, deterministic digest verification, Ed25519 publisher
verification, exact grant derivation, policy containment, JSON Schema
configuration validation and candidate health.

## Connector identity and secrets

- Pairing codes are high-entropy, hashed server-side, short-lived and consumed
  once.
- Pairing creates a 3072-bit RSA-OAEP-256 key pair inside the connector.
- The private key and machine credential remain in an owner-only local identity
  file. FLAMOX365 stores the public key and only a hash of the machine secret.
- Every managed secret is encrypted separately to the connector public key and
  decrypted only in memory.
- Secrets never enter the extension state, configuration, audit payload or
  Desktop state.
- Connector revocation invalidates future control-plane requests.

## Store and artifact trust

- Store publishers register an Ed25519 public JWK; private keys stay with the
  platform or customer publisher.
- Publisher key ids and extension ids cannot be taken over across tenant/global
  ownership boundaries.
- A connector can download only a release assigned to one of its installations.
- Artifact URLs must use the management origin and response bodies are streamed
  through explicit size limits.
- TLS is mandatory in production, but signature and digest validation remain
  independent integrity controls.

## Worker sandbox

Each extension worker receives read access only to its immutable package,
network access only to exact granted hosts and ports, and only named secrets
resolved for that extension. Environment access, writes, subprocesses, FFI and
system information are denied.

The runtime uses Deno's granular worker permission option and therefore runs
with `--unstable-worker-options`. Deno workers are a runtime sandbox, not a VM;
high-risk untrusted code may still justify a process/container-per-extension
boundary.

## Integrity and recovery

- Packages are staged, verified again at their content-addressed final path and
  made read-only before activation.
- State and control cursors use atomic owner-only replacement.
- A process lock prevents concurrent service, CLI or Desktop mutation.
- Candidate health precedes atomic activation; failed updates keep the previous
  revision active.
- Active packages are re-authorized and re-verified after restart.
- Audit events remain durable until idempotently accepted by FLAMOX365.

## Legacy compatibility surface

The retained outbound WebSocket uses OAuth2 client credentials, bounded frames,
heartbeat watchdogs and reconnect backoff. Secure `wss`/`https` is required by
default. The compatible inbound `/ws` listener is intentionally retained from
the upstream connector and should be restricted by network policy when unused.

Functions, YAML and proxy mode retain their original broad integration power.
They are legacy/operator-authored capabilities and do not inherit the managed
extension worker sandbox. Migrate third-party or remotely distributed logic to
signed extensions when isolation is required.

## Residual operator responsibilities

- Protect the operating-system account and deployment pipeline; either can
  replace binaries or local policy.
- Restrict outbound firewall access independently of Deno worker permissions.
- Review publisher provenance and grants before publication or installation.
- Treat non-secret configuration and operational audit data according to the
  customer's data-classification and retention rules.
- Rotate/revoke compromised connector credentials, publisher keys and secrets.
- Do not enable insecure transports outside an isolated local test network.

## Product release and vulnerability operations

The technical controls in this repository do not select a legal manufacturer,
support period, reporting authority or data-retention period. Before a customer
distribution, the publisher must establish and publish an operational process
that includes:

- a monitored private vulnerability-reporting contact and coordinated disclosure
  procedure;
- product ownership, supported versions, support lifetime and a secure update
  channel;
- dependency and software-bill-of-material evidence, recurring vulnerability
  review and release provenance;
- incident classification, customer notification and every applicable
  authority-reporting route and deadline;
- approved retention and deletion rules for connector identity, command,
  installation and audit information; and
- processor/controller responsibilities and employee-representation review where
  operational events can identify customer personnel.

Do not place a reporting address, retention duration or legal role into a build
until its owner has approved it. These are release-governance inputs, not safe
technical defaults.
