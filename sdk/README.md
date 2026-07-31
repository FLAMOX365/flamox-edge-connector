# @flamox/edge-connector-sdk

Minimal authoring contract for isolated Edge Connector extensions.

```json
{
  "imports": {
    "@edge-connector/sdk": "https://raw.githubusercontent.com/FLAMOX365/flamox-edge-connector/main/sdk/mod.ts"
  }
}
```

An entrypoint exports exactly one extension definition. Exported action names
must exactly match the signed manifest.

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

Inputs, configuration and outputs are JSON values. Secrets are strings scoped to
the names declared by the manifest and granted by local policy. The worker
cannot read other environment variables. Network calls use the platform
`fetch()` API and succeed only for exact granted hosts/ports.

The commit-pinned URL makes this repository the authoritative SDK source. During
`extension build` or `extension pack`, the CLI resolves the locked module graph
and bundles it into the `.fmx`. The worker therefore performs no remote imports
at the customer. Do not log secrets, return them from actions or store them in
configuration.
