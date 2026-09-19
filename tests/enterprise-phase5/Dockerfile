# Test tooling ONLY. The four production Dockerfiles remain separate evidence.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
ARG NPM_REGISTRY=https://packagefeedproxy.microsoft.io/npm/
ARG npm_config_registry=${NPM_REGISTRY}
ARG npm_config_fetch_retries=2
ARG npm_config_fetch_timeout=60000
ARG npm_config_loglevel=warn
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY src ./src
COPY upgrade ./upgrade
COPY tests ./tests
COPY scripts/generate-pool-name-catalog.mjs scripts/pool-name-tokens.mjs ./scripts/
# Keep devDependencies: production images intentionally prune tsx and tests.
RUN npm ci && npm run build:deploy
CMD ["node", "/app/tests/enterprise-phase5/run.mjs", "help"]
