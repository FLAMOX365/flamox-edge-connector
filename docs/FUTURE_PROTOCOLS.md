# Future Protocol Families

The connector is currently HTTP-only at the wire, runtime, SDK, and declarative
function levels. IMAP and SMTP are planned protocol families, but they are not
implemented yet. Future support must be added as real protocol contracts instead
of being tunneled through `HttpContext`, HTTP route files, or HTTP proxy mode.

This document describes where the architecture must be extended when a new
protocol family is introduced.

## Current Boundary

Today every cloud request frame carries a `EdgeConnectorHttpRequest`, and every
successful response frame carries a `EdgeConnectorHttpResponse`:

- `openapi/api.yml` defines the protocol frame schema.
- `runtime/generated/` contains generated TypeScript models from that schema.
- `runtime/protocol.ts` parses and serializes WebSocket frames.
- `runtime/connector.ts` owns the `ProtocolExecutor` boundary.
- `runtime/reloadable-request-executor.ts` chooses the HTTP execution mode.
- `runtime/function-scanner.ts` scans HTTP function files and YAML functions.
- `runtime/function-router.ts` executes HTTP functions.
- `runtime/proxy-router.ts` executes HTTP proxy forwarding.
- `sdk/http.ts` exposes the public HTTP SDK.

The current `ProtocolExecutor` name is intentionally broader than HTTP, but its
input and output types are still HTTP-specific because the wire schema is still
HTTP-only. The first real protocol expansion therefore starts at the OpenAPI
contract, not in the SDK.

## Non-Goals For The Current Release

- Do not add IMAP or SMTP request/response schemas yet.
- Do not add IMAP or SMTP SDK exports yet.
- Do not scan IMAP or SMTP functions yet.
- Do not add IMAP or SMTP templates yet.
- Do not model IMAP or SMTP as special HTTP methods, paths, headers, or proxy
  targets.
- Do not extend `HttpContext` with mail-specific concepts.

## Extension Sequence

Add a new protocol family in this order.

### 1. Design The Wire Contract

Extend `openapi/api.yml` before runtime or SDK code changes. The frame contract
needs to identify which protocol family the request belongs to and carry a
protocol-specific payload.

The current request shape is:

```yaml
EdgeConnectorRequestFrame:
  request:
    $ref: "#/components/schemas/EdgeConnectorHttpRequest"
```

A future design should make the request payload discriminated by protocol, for
example:

```yaml
EdgeConnectorProtocol:
  type: string
  enum:
    - http
    - imap
    - smtp

EdgeConnectorRequestFrame:
  properties:
    protocol:
      $ref: "#/components/schemas/EdgeConnectorProtocol"
    request:
      oneOf:
        - $ref: "#/components/schemas/EdgeConnectorHttpRequest"
        - $ref: "#/components/schemas/EdgeConnectorImapRequest"
        - $ref: "#/components/schemas/EdgeConnectorSmtpRequest"
```

The exact schema may differ, but the important requirements are:

- The frame must be self-describing without inspecting HTTP-shaped fields.
- Each protocol request and response must have its own schema.
- Protocol-specific errors must either reuse `EdgeConnectorError` deliberately
  or define explicit protocol error details.
- Timeout, retry, cancellation, and payload-size semantics must be clear per
  protocol.
- Binary payloads must define an encoding strategy before implementation.

After changing the schema, regenerate models with:

```sh
npx -y deno task --cwd runtime generate-api
```

Then update `runtime/protocol.ts` type guards and tests so invalid protocol
payloads fail at the frame boundary.

### 2. Generalize The Runtime Executor Type

Update `runtime/connector.ts` after the generated models contain protocol-aware
request and response unions.

The current executor shape is intentionally temporary:

```ts
export interface ProtocolExecutor {
  execute(
    frame: EdgeConnectorRequestFrame,
  ): Promise<EdgeConnectorHttpResponse>;
}
```

For multi-protocol support, change it to return the protocol response union from
the generated API, for example:

```ts
export interface ProtocolExecutor {
  execute(frame: EdgeConnectorRequestFrame): Promise<EdgeConnectorResponse>;
}
```

`ConnectorRuntime.handleRequestFrame` should remain generic: parse a request
frame, call the executor, and wrap the result in a response frame. It should not
know how IMAP, SMTP, or HTTP execution works internally.

### 3. Introduce A Protocol Dispatcher

`runtime/reloadable-request-executor.ts` currently composes only HTTP function
mode or HTTP proxy mode. With multiple protocols, it should become a dispatcher
that keeps one executor per protocol family.

The future shape should be conceptually close to:

```ts
type ProtocolFamily = "http" | "imap" | "smtp";

class ReloadableProtocolExecutor implements ProtocolExecutor {
  private readonly executors = new Map<ProtocolFamily, ProtocolExecutor>();

  execute(frame: EdgeConnectorRequestFrame) {
    const executor = this.executors.get(frame.protocol);
    if (!executor) throw new RuntimeError("UNSUPPORTED_PROTOCOL", ...);
    return executor.execute(frame);
  }
}
```

HTTP mode selection should stay inside an HTTP-specific composer. Avoid growing
one large reload method that knows every protocol's scanning and routing rules.

Recommended split:

- `runtime/http-protocol-executor.ts` composes HTTP functions vs HTTP proxy.
- `runtime/imap-protocol-executor.ts` composes IMAP-specific handlers later.
- `runtime/smtp-protocol-executor.ts` composes SMTP-specific handlers later.
- `runtime/reloadable-request-executor.ts` dispatches by `frame.protocol` and
  coordinates reloads.

### 4. Add Protocol-Specific Runtime Modules

Each protocol family should own its scanner, route registry, context creation,
and executor. Do not add protocol branches inside `HttpFunctionScanner` or
`HttpFunctionRouter`.

HTTP remains:

- `runtime/function-scanner.ts`
- `runtime/function-router.ts`
- `runtime/proxy-router.ts`

Future IMAP should use separate modules such as:

- `runtime/imap-function-scanner.ts`
- `runtime/imap-function-router.ts`
- `runtime/imap-context.ts` if context construction becomes runtime-owned

Future SMTP should use separate modules such as:

- `runtime/smtp-function-scanner.ts`
- `runtime/smtp-function-router.ts`
- `runtime/smtp-context.ts` if context construction becomes runtime-owned

The protocol executor should translate generated request models into the
protocol SDK context and translate SDK handler results back into generated
response models.

### 5. Add Protocol-Specific SDK Files

Mirror the HTTP SDK shape instead of extending it. The equal-persona rule still
applies: every protocol should support a functional style and a fluent style.

Current HTTP public API:

```ts
import { defineHttp, http } from "@flamox/edge-connector-sdk";

export default defineHttp({
  get: (ctx) => ctx.res.ok().json({ ok: true }),
});

export default http()
  .get((ctx) => ctx.res.ok().json({ ok: true }));
```

Future IMAP should live in `sdk/imap.ts` and expose names like:

```ts
export default defineImap({
  fetchMessage: async (ctx) => { ... },
});

export default imap()
  .fetchMessage(async (ctx) => { ... })
  .searchMailbox(async (ctx) => { ... });
```

Future SMTP should live in `sdk/smtp.ts` and expose names like:

```ts
export default defineSmtp({
  sendMessage: async (ctx) => { ... },
});

export default smtp()
  .sendMessage(async (ctx) => { ... });
```

Only export these from `sdk/mod.ts` once the runtime and wire contract exist.
The SDK route definitions should be discriminated:

```ts
type ImapRouteDefinition = {
  readonly protocol: "imap";
  readonly handlers: ...;
};

type SmtpRouteDefinition = {
  readonly protocol: "smtp";
  readonly handlers: ...;
};
```

### 6. Define File-System Ownership

The current `functions/` directory is HTTP-oriented: file paths map to URL
routes, dynamic path segments, catch-all paths, and HTTP methods. IMAP and SMTP
should not reuse that URL routing model.

Before implementation, choose one ownership model:

- Separate roots, for example `functions/http`, `functions/imap`, and
  `functions/smtp`.
- Or a protocol marker in each module's default export and one scanner that
  delegates to protocol-specific scanners.
- Or protocol-specific configured directories such as `HTTP_FUNCTIONS_DIR`,
  `IMAP_FUNCTIONS_DIR`, and `SMTP_FUNCTIONS_DIR`.

The preferred direction is separate protocol roots because HTTP path routing and
mail operation routing are different concepts. If that is adopted, update:

- `runtime/config.ts` for protocol-specific directories.
- `runtime/function-watcher.ts` so reloads trigger for every configured root.
- `runtime/main.ts` so startup creates the protocol dispatcher with all roots.
- README and installation docs to explain the directory layout.

### 7. Add Declarative Config Later

YAML functions are currently HTTP-only and implemented through
`runtime/yaml-functions.ts`, then wrapped by `HttpFunctionScanner`. Keep them
HTTP-only until non-HTTP request and response contracts are stable.

When declarative IMAP or SMTP support is added, create separate schemas and
runtime modules:

- `schemas/yaml-imap-function.schema.json`
- `schemas/yaml-smtp-function.schema.json`
- `runtime/yaml-imap-functions.ts`
- `runtime/yaml-smtp-functions.ts`

Do not add mail fields to the existing HTTP YAML schema. That schema should
continue to describe target HTTP requests and HTTP response transforms only.

### 8. Update Templates Last

Templates should be added only after wire, runtime, SDK, and tests are stable.
At that point, add protocol-specific examples instead of mixing concepts into
the HTTP starter.

Recommended template structure:

```text
templates/examples/imap-mailbox/
templates/examples/smtp-outbound-mail/
```

Keep `templates/starter/` focused on HTTP unless the starter intentionally grows
into a multi-protocol starter with separate folders and clear documentation.

## IMAP Design Notes

IMAP is stateful and mailbox-oriented. The contract should avoid exposing a raw
socket abstraction to user functions. Prefer explicit operations such as search,
fetch message, fetch attachment, move, flag, delete, and list mailboxes.

Decisions needed before implementation:

- How mailbox connection credentials are supplied and scoped.
- Whether a cloud request represents one IMAP operation or a batch.
- How message bodies and attachments are encoded.
- How large attachment streaming works.
- How flags, folders, UID validity, and server-specific capabilities are
  represented.
- Which operations are idempotent and safe to retry.

## SMTP Design Notes

SMTP is submission-oriented and has delivery semantics that differ from a normal
request/response API. The contract should represent message submission clearly
instead of pretending that an accepted message is equivalent to delivered mail.

Decisions needed before implementation:

- Whether the response reports accepted recipients, rejected recipients, queue
  IDs, or delivery status handles.
- How envelope sender/recipients differ from message headers.
- How attachments and inline content are encoded.
- How DKIM, SPF alignment, bounce handling, and provider-specific metadata are
  represented or deliberately excluded.
- Which failures are retryable and how partial recipient failures are modeled.

## Test Requirements

Every new protocol family needs tests at the same layers as HTTP:

- OpenAPI generation produces the expected TypeScript models.
- `runtime/protocol.ts` accepts and rejects protocol frames correctly.
- `runtime/connector.ts` dispatches a request frame and wraps protocol-specific
  responses and errors correctly.
- The protocol dispatcher rejects unsupported protocol values.
- Protocol scanners load functional and fluent SDK route definitions.
- Protocol routers translate generated request models to SDK contexts.
- Templates typecheck against the local SDK.

Run the normal repo checks after adding a protocol:

```sh
npx -y deno task check
npx -y deno task lint
npx -y deno task test
```

If templates import an unpublished SDK version, typecheck them with a temporary
local import map just like the HTTP template verification does today.
