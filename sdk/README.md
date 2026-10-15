# @edge-connector/sdk

The Node.js 26 / TypeScript 7 authoring contract for Edge Connector extensions
and retained operator HTTP Functions. The source belongs to the connector;
the extensions catalog pins it through its Git submodule.

```bash
yarn workspace @edge-connector/sdk build
```

Use the built package as a locked `file:` dependency pointing to the SDK in the
pinned checkout. Package exports include `extension`, `http`, `errors`, `types`,
`areas/telephony`, `areas/telephony-schemas` and `tcp`. JavaScript ESM and
TypeScript declarations are emitted in `dist`.

```ts
import { defineExtension } from "@edge-connector/sdk";

export default defineExtension({
  actions: {
    status: (context, input) => ({
      requestId: context.requestId,
      configured: context.configuration.enabled ?? false,
      input,
    }),
  },
});
```

Declared actions must exactly match the signed manifest. Inputs, configuration
and outputs are JSON values. Only named, granted secrets enter the context;
the connector's parent environment is not inherited. Do not log secrets,
return them from actions or store them in configuration.

HTTP/fetch requests use the authenticated per-extension proxy. For a native TCP
driver, `connectTcp(host, port, timeoutMilliseconds)` from
`@edge-connector/sdk/tcp` returns a Node socket through the same grant-filtered
SOCKS proxy. It requires a sandbox-provided authenticated proxy and never falls
back to a direct connection. The SQL Server extension passes it to Tedious's
`options.connector` seam.

The CLI type-checks and bundles the locked graph into `runtime/extension.mjs`.
Installed extensions do not resolve npm/JSR/HTTP imports, load native addons or
spawn child processes. Network policy remains enforced by the OS and proxy,
not by trusting extension code to use these SDK helpers.
