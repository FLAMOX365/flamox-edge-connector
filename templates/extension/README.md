# Customer extension starter

This directory remains a complete, customer-owned extension package for
compatibility. New projects should use the guided Extension CLI:

```sh
extension init ./my-extension
```

The wizard creates, validates, tests, signs and packages the extension and can
upload it directly to FLAMOX365. For the retained manual flow, copy this
directory, change the manifest identity, publisher, permissions, schema and
actions, and keep private publisher keys outside the package and source
repository.

Keep the commit-pinned Edge Connector SDK reference in `deno.json` and run
`deno install` after changing dependencies. The generated lock file is required
for deterministic bundling.

```sh
deno task extensions keygen "Customer GmbH" customer-2026 private.jwk trust.json
deno task extensions sign ./my-extension private.jwk customer-2026 release.json
deno task extensions pack ./my-extension release.json customer-example-1.0.0.fmx
```

Register only the public key from `trust.json` in FLAMOX365. Upload the `.fmx`
bundle afterwards. The private JWK remains with its publisher. For local
testing, install the bundle and its exact grant through the Desktop app or with
`deno task extensions install-bundle`.
