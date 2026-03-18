# ---- Build stage: TypeScript + Vite frontend ----
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src/ ./src/
RUN npm run build

# ---- Production stage ----
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled server + built web frontend
COPY --from=builder /app/dist ./dist

# Config file is expected to be mounted at runtime (see docker-compose.yml)
# Default path; override with CONFIG_PATH env var
ENV CONFIG_PATH=/app/config.yaml
ENV PORT=3000

EXPOSE 3000

# Health check using the built-in health endpoint
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget -q --spider http://localhost:3000/api/health || exit 1

CMD ["node", "dist/server/index.js"]
