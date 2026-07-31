FROM denoland/deno:2.9.4@sha256:c777b4b225501a61074837e90a826a58f99124837824023cd60334b1e2374498

LABEL org.opencontainers.image.source="https://github.com/FLAMOX365/flamox-edge-connector" \
      org.opencontainers.image.description="Edge Connector runtime" \
      org.opencontainers.image.licenses="MIT"

# Create app directory
WORKDIR /app

# Copy source files
COPY deno.json .
COPY deno.lock .
COPY runtime/ ./runtime/
COPY sdk/ ./sdk/

# Cache dependencies
RUN deno cache --frozen runtime/main.ts

# Durable state is writable only by the non-root runtime user.
RUN mkdir -p /data && chown -R deno:deno /data

# Non-root user (Deno image uses uid 1000)
USER deno

ENV EDGE_CONNECTOR_DATA_DIRECTORY=/data

# Expose default port
EXPOSE 8080

# Health check (liveness). Needs --allow-env to read EDGE_CONNECTOR_BIND_PORT.
# start-period covers the initial WebSocket connect so the container is not
# marked unhealthy while it is still establishing the first connection.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD deno run --allow-net --allow-env runtime/health-check.ts || exit 1

# Start the connector
CMD ["deno", "run", "--unstable-worker-options", "--allow-net", "--allow-env", "--allow-read", "--allow-write=/data", "runtime/main.ts"]
