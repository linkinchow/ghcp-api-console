FROM node:22-bookworm-slim
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG npm_config_registry=${NPM_REGISTRY}
ARG npm_config_fetch_retries=2
ARG npm_config_fetch_timeout=60000
ARG npm_config_loglevel=warn
WORKDIR /app
COPY package*.json ./
COPY tsconfig.base.json ./
COPY src ./src
RUN npm ci \
  && npx playwright install --with-deps chromium \
  && npm --workspace @ghcp/shared run build \
  && npm --workspace @ghcp/login run build \
  && npm prune --omit=dev
ENV NODE_ENV=production
EXPOSE 7003
CMD ["npm", "--workspace", "@ghcp/login", "run", "start:prod"]
