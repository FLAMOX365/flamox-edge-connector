FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS build

WORKDIR /app
RUN npm install --global corepack@0.36.0 && corepack enable
COPY package.json yarn.lock .yarnrc.yml tsconfig.json tsconfig.build.json ./
COPY sdk/ ./sdk/
COPY templates/starter/package.json ./templates/starter/package.json
COPY templates/extension/package.json ./templates/extension/package.json
COPY templates/examples/ad-user-export/package.json ./templates/examples/ad-user-export/package.json
COPY templates/examples/erp-integration/package.json ./templates/examples/erp-integration/package.json
COPY templates/examples/ticketing-yaml/package.json ./templates/examples/ticketing-yaml/package.json
RUN yarn install --immutable
COPY runtime/ ./runtime/
COPY cli/ ./cli/
COPY desktop/*.ts ./desktop/
COPY tools/ ./tools/
COPY test/ ./test/
RUN yarn build && yarn workspaces focus --all --production

FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9
LABEL org.opencontainers.image.source="https://github.com/FLAMOX365/flamox-edge-connector" \
      org.opencontainers.image.description="Edge Connector runtime" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update && apt-get install --yes --no-install-recommends bubblewrap socat ripgrep ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist/ ./dist/
COPY --from=build /app/sdk/ ./sdk/
COPY --from=build /app/node_modules/ ./node_modules/
RUN mkdir -p /data && chown node:node /data
USER node
ENV EDGE_CONNECTOR_DATA_DIRECTORY=/data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD node dist/runtime/health-check.js || exit 1
CMD ["node", "dist/runtime/main.js"]
