# Multi-stage build for Sherweb MCP Server
FROM node:26-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:26-alpine AS production
RUN addgroup -g 1001 -S appuser && adduser -S appuser -u 1001 -G appuser
WORKDIR /app
COPY package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
RUN npm prune --omit=dev && npm cache clean --force
USER appuser
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1
# 0.0.0.0 is safe here only because startup refuses to listen without a real
# CONDUIT_S2S_SECRET. AUTH_MODE=gateway never falls back to image env credentials.
# MCP_ALLOW_INSECURE_DEV=1 binds 127.0.0.1 only, which does not accept traffic
# published from outside the container.
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    MCP_HTTP_PORT=8080 \
    MCP_HTTP_HOST=0.0.0.0 \
    AUTH_MODE=gateway \
    LOG_LEVEL=info
CMD ["node", "dist/index.js"]

LABEL maintainer="engineering@wyre.ai"
LABEL description="Sherweb Partner API MCP Server"
LABEL org.opencontainers.image.title="sherweb-mcp"
LABEL org.opencontainers.image.description="Model Context Protocol server for Sherweb Partner API - distributor billing, service providers, subscriptions"
LABEL org.opencontainers.image.vendor="Wyre Technology"
LABEL io.modelcontextprotocol.server.name="io.github.WYRE-AI/sherweb-mcp"
