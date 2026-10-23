# ── AgentPay — production Docker image ────────────────────────────────────────
# Works on: Northflank (recommended free tier), Railway, Hugging Face Docker Spaces.
#
# Northflank Sandbox (FREE — always-on, no sleep, persistent NVMe volume):
#   - Deploy as a Combined Service from this repo.
#   - Add a Volume and mount it at /data (SQLite persists here).
#   - Set PORT=3001 (Northflank forwards HTTP from the public port).
#   - Set PRODUCTION_ORIGIN to your Netlify frontend URL (CORS).
#   - Set NODE_ENV=production.
#   - Set JWT_SECRET to a random 32+ char string.
#
# Railway ($1/mo free credit — always-on within budget):
#   - PORT is injected automatically by Railway.
#   - Mount a Volume at /data.
#
# HF Spaces usage (requires HF Pro):
#   - Exposes port 7860 (set PORT=7860).
#   - Override CMD to: ["node", "scripts/start-prod.cjs"] for full-stack.
# ──────────────────────────────────────────────────────────────────────────────

FROM oven/bun:1.2-slim

WORKDIR /app

# Copy manifests first for layer caching
COPY package.json bun.lock* ./

# Install all deps (devDeps needed for Vite build)
RUN bun install --frozen-lockfile

# Copy full source
COPY . .

# Build Vite frontend into /app/dist (used by HF full-stack mode)
RUN bun run --bun vite build

# Persistent data directory — Railway mounts a Volume here
RUN mkdir -p /data

# Railway injects PORT automatically; fall back to 3001 for local docker run.
ENV PORT=3001
ENV NODE_ENV=production
ENV AGENTPAY_DB_PATH=/data/agentpay.db

EXPOSE 3001

# Default: run only the API server (Railway mode).
# For HF full-stack, override CMD to: ["node", "scripts/start-prod.cjs"]
CMD ["bun", "run", "server/index.ts"]
