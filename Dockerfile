# ---- Build stage: TypeScript + Vite frontend ----
# node:22-slim (debian-slim / glibc) rather than alpine (musl). Alpine + QEMU
# cross-arch emulation causes npm to crash with "Exit handler never called!"
# partway through `npm ci`. glibc is stable.
FROM node:22-slim AS builder
WORKDIR /app

# Build tools are required for better-sqlite3's native addon — node:slim
# doesn't include them. Without these, npm falls back to compile and aborts
# because g++/python3/make are missing.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Escape hatch for corporate networks that intercept TLS (MITM proxies).
# Default stays strict; override with `--build-arg NPM_STRICT_SSL=false`
# when building from a network where registry.npmjs.org is proxied.
ARG NPM_STRICT_SSL=true

COPY package*.json ./
# strict-ssl covers npm itself; NODE_TLS_REJECT_UNAUTHORIZED covers child
# processes like prebuild-install and node-gyp (which fetch prebuilt binaries
# and node headers respectively, and don't honour npm's strict-ssl).
RUN npm config set strict-ssl ${NPM_STRICT_SSL} && \
    NODE_TLS_REJECT_UNAUTHORIZED=$([ "$NPM_STRICT_SSL" = "true" ] && echo 1 || echo 0) npm ci

COPY tsconfig.json vite.config.ts ./
COPY src/ ./src/
RUN npm run build

# Strip dev dependencies from node_modules so the production stage can reuse
# them without running `npm ci` a second time.
RUN npm prune --omit=dev && npm cache clean --force

# ---- Production stage ----
FROM node:22-slim
WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Config file is expected to be mounted at runtime (see docker-compose.yml)
# Default path; override with CONFIG_PATH env var
ENV CONFIG_PATH=/app/config.yaml
ENV PORT=3000

EXPOSE 3000

# Health check uses node's built-in fetch so no extra packages are needed.
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" || exit 1

CMD ["node", "dist/server/index.js"]
