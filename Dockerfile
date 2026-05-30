FROM node:20-alpine

WORKDIR /app

# Healthcheck dependency (wget not included in alpine by default)
RUN apk add --no-cache wget

# Install deps first (layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY server.js .
COPY schemas/ ./schemas/
COPY telnyx/ ./telnyx/
COPY livekit-agent/index.js ./livekit-agent/index.js

# Non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server.js"]
