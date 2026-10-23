# AgentPay — Free Deployment Guide

**Total cost: $0/month. No credit card required.**

## Verified free-tier landscape (October 2026)

| Platform | Always-on | Persistent storage | Card | Verdict |
|---|---|---|---|---|
| **Northflank Sandbox** | Yes — never sleeps | Yes — NVMe volumes | No | **Recommended** |
| Railway Free | Yes — $1/mo credit | Yes — 500 MB volume | No | Works, small credit budget |
| Render Free | No — sleeps after 15 min idle | No — ephemeral only | No | SQLite lost on every restart |
| Fly.io | No free tier | N/A | Yes | Not free |
| Koyeb Free | Scale-to-zero (1hr idle) | No volumes on free | Yes (verify) | No persistent storage |
| HF Docker Spaces | Yes | Yes | No | Requires $9/mo HF Pro |

## Architecture

```
Browser
  │
  ├─► Netlify (static frontend, free forever)
  │     VITE_API_BASE_URL=https://agentpay.coderun.app
  │
  └─► Northflank (Express + Bun backend, free Sandbox tier)
        Port 3001 → public HTTPS URL
        /data volume → SQLite (agentpay.db, persistent NVMe)
```

---

## Step 1 — Backend on Northflank Sandbox (free, always-on)

### 1.1 Create a Northflank account

Go to [northflank.com](https://northflank.com) → Sign up. **No credit card required.**

### 1.2 Create a project

Dashboard → **New project** → name it `agentpay` → Create.

### 1.3 Create a Combined Service (build + run from your repo)

Inside the project → **New service** → **Combined service** → Connect GitHub → select this repo.

Settings to fill in:

| Field | Value |
|---|---|
| Branch | `main` |
| Build type | **Dockerfile** |
| Dockerfile path | `Dockerfile` |
| Port | `3001` |
| Protocol | `HTTP` |

### 1.4 Add environment variables

In the service → **Environment** tab → add these variables:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3001` |
| `PRODUCTION_ORIGIN` | `https://remarkable-trifle-62f8bd.netlify.app` |
| `JWT_SECRET` | any random 32+ char string (e.g. output of `openssl rand -hex 32`) |
| `AGENTPAY_DB_PATH` | `/data/agentpay.db` |

Optional (for autonomous DCW payments):

| Variable | Value |
|---|---|
| `CIRCLE_API_KEY` | your Circle Standard Developer API key |
| `CIRCLE_ENTITY_SECRET` | your 32-byte hex entity secret |

### 1.5 Add a persistent volume for SQLite

Service → **Volumes** tab → **Add volume**:

| Field | Value |
|---|---|
| Mount path | `/data` |
| Size | `1 GiB` (minimum; can increase later) |

> SQLite database at `/data/agentpay.db` survives all restarts, redeployments, and scaling events.

### 1.6 Deploy

Click **Deploy** (or it deploys automatically after env vars are saved).

Build takes ~3 minutes (Bun install + Vite build inside Docker).

### 1.7 Get your public URL

Service → **Networking** tab → copy the generated `.coderun.app` domain.
It looks like: `https://agentpay-abcd1234.coderun.app`

### 1.8 Verify the backend is running

```bash
curl https://agentpay-abcd1234.coderun.app/api/health
# Expected: {"ok":true,"db":"ok","env":"production"}
```

---

## Step 2 — Point the Netlify frontend at your backend

### 2.1 Set the API base URL

In Netlify dashboard → **Site configuration** → **Environment variables** → **Add variable**:

| Key | Value |
|---|---|
| `VITE_API_BASE_URL` | `https://agentpay-abcd1234.coderun.app` |

### 2.2 Redeploy

Netlify dashboard → **Deploys** → **Trigger deploy** → **Deploy site**.

Wait ~1 minute for the build to finish.

### 2.3 Make the site public

Netlify dashboard → **Site configuration** → **Access control** → **Site protection** → set to **None** (Open).

*(Arc Studio deploys with auth by default — this step makes it publicly accessible.)*

### 2.4 Verify end-to-end

Open `https://remarkable-trifle-62f8bd.netlify.app`:

1. Wallet connect button appears → MetaMask connects successfully.
2. Dashboard loads with empty state (no agents yet).
3. Create an agent → it persists after a browser refresh.
4. `/api/health` returns `{"ok":true}` from the Northflank backend.

---

## Step 3 — Verify CORS and authentication

The backend allows these origins by default:
- `http://localhost:5173` (dev)
- `http://localhost:3000` (dev)
- The value of `PRODUCTION_ORIGIN` env var

If you see CORS errors, confirm `PRODUCTION_ORIGIN` matches your exact Netlify URL including the `https://` scheme and no trailing slash.

---

## Northflank Sandbox limits

| Limit | Value |
|---|---|
| Services | 2 (use one for AgentPay backend) |
| Included compute | Up to $20/mo of CPU + memory |
| Volume size | Up to whatever $20/mo covers (NVMe at $0.11657/GiB/mo) |
| Sleep | Never — always-on |
| Credit card | Not required |
| Custom domains | Supported on Sandbox |
| Expiry | No expiry — free forever |

At 0.1 vCPU + 256 MB RAM (the smallest useful size), the backend costs well under $5/month of compute, fully within the $20 Sandbox allowance.

---

## Railway as an alternative

Railway's Free plan gives $1/month of non-rollover compute credits — enough for a very small always-on service.

- No credit card required to sign up.
- `railway.toml` is already in this repo.
- Add a volume at `/data` (500 MB free).
- Set the same environment variables as above.
- Railway auto-injects `PORT`; do not set it manually.

The risk: if the $1/month credit runs out (unlikely for a low-traffic demo), the service pauses until the next month. Northflank has no such risk.

---

## Current deployment status

| Component | URL | Status |
|---|---|---|
| Frontend | `https://remarkable-trifle-62f8bd.netlify.app` | Live (requires Netlify auth disable) |
| Backend | Pending your Northflank setup (Step 1) | Not yet deployed |

---

## Troubleshooting

**CORS errors in browser** — check that `PRODUCTION_ORIGIN` in Northflank env matches the exact Netlify URL.

**"Cannot connect to API"** — check the Northflank service logs; the first deploy takes ~3 min. Also verify `VITE_API_BASE_URL` is set in Netlify and the site was redeployed after setting it.

**"Autonomous execution not configured"** — add `CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET` to Northflank env vars and redeploy.

**SQLite not persisting** — confirm the Volume is mounted at `/data` and `AGENTPAY_DB_PATH=/data/agentpay.db` is set.

**JWT sessions expire on restart** — set `JWT_SECRET` to a stable value; without it a random key is generated per restart and all sessions are invalidated.
