FROM node:20-alpine

WORKDIR /app

# Install deps first (layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY server.js .
COPY schemas/ ./schemas/
COPY telnyx/ ./telnyx/
COPY livekit-agent/index.js ./livekit-agent/index.js
COPY openai/ ./openai/

# Non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
