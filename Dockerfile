# ---- Build stage ----
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- Production stage ----
FROM node:20-alpine AS production
WORKDIR /app

ENV NODE_ENV=production

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Config file is expected to be mounted at runtime (see docker-compose.yml)
# Default path; override with CONFIG_PATH env var
ENV CONFIG_PATH=/app/config.yaml

CMD ["node", "dist/index.js"]
