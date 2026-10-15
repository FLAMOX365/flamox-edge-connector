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

Keep the SDK package reference in `package.json`, pointing to a built, pinned
connector checkout after copying the template, and run `yarn install` after changing dependencies. Commit
`yarn.lock` for deterministic bundling. Inside this repository the SDK is linked as a Yarn workspace. After copying
the template, replace that dependency with a `file:` reference to the built SDK.

```sh
yarn extension build ./my-extension
yarn extensions keygen "Customer GmbH" customer-2026 private.jwk trust.json
yarn extensions sign ./my-extension/dist private.jwk customer-2026 release.json
yarn extensions pack ./my-extension/dist release.json customer-example-1.0.0.fmx
```

Register only the public key from `trust.json` in FLAMOX365. Upload the `.fmx`
bundle afterwards. The private JWK remains with its publisher. For local
testing, install the bundle and its exact grant through the Desktop app or with
`yarn extensions install-bundle`.
