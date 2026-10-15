# Contributing

The project uses Node.js 26.12.0, TypeScript 7.0.2 and Yarn 4.18.1 and keeps the runtime, SDK, and generated
protocol models in one workspace. Fork the repository, create a focused branch,
and keep each pull request small enough to review as one coherent change.

Install the locked dependency graph before development:

```bash
yarn install --immutable
```

Run the complete local gate before opening a pull request:

```bash
yarn check
yarn lint
yarn test:coverage
yarn test:native
yarn check:templates
yarn fmt
yarn audit
yarn verify:generated
```

See [regression verification](docs/TESTING.md) for the behavior matrix, native
prerequisites, expected negative-test output and device/platform qualification.

Changes to `openapi/api.yml` require `yarn generate:api`. Never hand-edit
`runtime/generated/`.

Security-sensitive changes need focused tests for deny-by-default behavior,
publisher verification, local policy, worker permissions, state recovery and
failed-update rollback. Do not add transparent proxy fallbacks or routes that
mutate extension state without the complete `ExtensionManager` verification
path.

Never commit credentials, publisher private keys, customer data, `.fmx`
artifacts, runtime state, or local environment files. New bundled dependencies
must be version-locked, security-audited, and accompanied by all license notices
required for redistribution.

Documentation, examples, schemas, and tests must change with the behavior they
describe. Use `FLAMOX365` and `Edge Connector` exactly in human-readable text;
do not combine them into one product name.

The MIT license and original copyright notice remain in `LICENSE`.
