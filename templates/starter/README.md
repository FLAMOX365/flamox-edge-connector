# Edge Connector starter

This deployment starts the production service host with durable identity,
extension and control state. Copy the two example local safety overlays from the
repository `config/` directory into a local `config/` directory. Empty overlays
trust no publisher and permit no extension until the customer approves rules.

```bash
cp .env.example .env
mkdir -p config
cp ../../config/extension-policy.example.json config/extension-policy.json
cp ../../config/trusted-publishers.example.json config/trusted-publishers.json
docker compose up --build -d
curl http://127.0.0.1:8080/health
```

Before the first start, create a pairing code in FLAMOX365 and put the
management URL, one-time code and display name into `.env`. Remove the code
after pairing, but preserve the volume. The durable Docker volume contains
tenant identity, control cursors, audit outbox, installed packages and observed
state.

Never place secrets in an extension configuration file. Managed values are
delivered encrypted for the paired connector; local extensions use only the
environment variables explicitly named by the manifest and policy.
