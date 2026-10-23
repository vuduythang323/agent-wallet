# AgentPay

A programmable USDC wallet that lets AI agents make authorized payments on Arc
Testnet while users retain control over budgets, permissions, and transaction
approval.

Built with [Arc Studio](https://studio.arc.io)

---

## What it does

AgentPay gives developers a secure way to let AI agents spend USDC autonomously
within predefined rules.

- Create agents with spending budgets, per-transaction caps, daily/monthly limits,
  recipient allowlists, and purpose restrictions.
- An agent calls the REST API with its API key to request a payment.
- The policy engine approves, queues for human review, or rejects the request.
- Approved payments execute automatically via Circle Developer-Controlled Wallets —
  no MetaMask popup required.
- Every action is audit-logged; agents can be paused or revoked instantly.

---

## Tech stack

- **Frontend:** React 18, TypeScript, Tailwind CSS, wagmi v2, ConnectKit
- **Backend:** Express 5, bun:sqlite (WAL mode), SIWE authentication, HS256 JWT
- **Wallet execution:** Circle Developer-Controlled Wallets SDK (per-agent EOA wallets)
- **Chain:** Arc Testnet (USDC as native gas token)
- **Tests:** bun:test — 61 tests across 3 files

---

## Development

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- Node.js 20+ (for Circle CLI; optional)

### Install

```bash
bun install
```

### Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `CIRCLE_API_KEY` | Optional* | Circle Standard Developer API key for autonomous DCW execution |
| `CIRCLE_ENTITY_SECRET` | Optional* | 32-byte hex entity secret for Circle DCW signing |
| `ALLOWED_ORIGIN` | Optional | Additional CORS origin to allow (production frontend URL) |
| `PRODUCTION_ORIGIN` | Yes (production) | Production frontend origin added to CORS allowlist |
| `AGENTPAY_DB_PATH` | Optional | Custom SQLite database path (default: `agentpay.db`) |
| `PORT` | Optional | API server port (default: `3001`; Railway injects automatically) |
| `JWT_SECRET` | Optional | 32+ char secret for signing JWTs; random per-restart if unset |
| `VITE_API_BASE_URL` | Optional | Frontend-only: full URL of the backend (e.g. Railway URL) |
| `RPC_PROXY_BASE_URL` | Optional (Arc Studio) | Arc Studio RPC proxy base URL |
| `RPC_PROXY_TOKEN` | Optional (Arc Studio) | Arc Studio RPC proxy auth token |
| `RPC_PROXY_CHAINS` | Optional (Arc Studio) | Comma-separated list of proxied chain keys |

*Without `CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET`, the dashboard and manual
payment flows work, but autonomous execution (`POST /api/payments/:id/execute`)
returns 503. See `docs/sprint3-setup.md` for setup.

### Run (development)

Start the API server and the frontend dev server in separate terminals:

```bash
# Terminal 1 — API server (port 3001)
bun run server

# Terminal 2 — Frontend (port 5173)
bun run dev
```

The frontend proxies `/api/*` to `http://localhost:3001` via Vite.

### Test

```bash
bun test server/tests/
```

Output: 61 tests, 0 failures.

| Suite | Tests | What it covers |
|-------|-------|----------------|
| `policy.test.ts` | 30 | All 8 policy rules, CRITICAL-1 reservation edge cases |
| `security.test.ts` | 19 | 6 confirmed exploit regression tests |
| `flows.test.ts` | 12 | Full state machine, MVP acceptance criteria, DCW unconfigured |

---

## Autonomous payment setup

To enable agents to execute payments without MetaMask:

1. Add `CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET` to `.env`.
2. Call `POST /api/agents/:id/provision-wallet` (owner JWT required).
3. Fund the agent's wallet address with USDC on Arc Testnet.
4. Agents call `POST /api/payments/:id/execute` (API key required).

See `docs/sprint3-setup.md` for the full guide.

---

## API summary

### Authentication

Owner-facing routes require `Authorization: Bearer <jwt>`.

```bash
# 1. Get a nonce
curl http://localhost:3001/api/auth/nonce

# 2. Sign the SIWE message with your wallet and verify
curl -X POST http://localhost:3001/api/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"message":"...","signature":"0x..."}'
# → { "token": "eyJ...", "address": "0x..." }
```

### Agent management (JWT required)

```
POST   /api/agents                          Create agent (returns API key once)
GET    /api/agents                          List agents
GET    /api/agents/:id                      Get agent details
PATCH  /api/agents/:id/policy               Update spending policy
POST   /api/agents/:id/pause                Pause agent
POST   /api/agents/:id/resume               Resume agent
POST   /api/agents/:id/revoke               Revoke (permanent)
POST   /api/agents/:id/provision-wallet     Provision DCW wallet
GET    /api/agents/:id/wallet-balance       Read DCW wallet USDC balance
```

### Payments (agent API key for request/execute; JWT for approve/reject/submit/confirm)

```
POST   /api/payments/request                Submit payment request
POST   /api/payments/:id/execute            Execute autonomously via DCW
POST   /api/payments/:id/approve            Human approval
POST   /api/payments/:id/reject             Human rejection
POST   /api/payments/:id/submit             Manual tx hash submission
POST   /api/payments/:id/confirm            Manual confirmation
POST   /api/payments/:id/fail               Mark failed
GET    /api/payments                        List payments
GET    /api/payments/:id                    Get payment details
```

### Other

```
GET    /api/audit                           Audit log
GET    /api/health                          Health check
```

---

## Security

- Owner identity verified via SIWE (EIP-4361) + HS256 JWT.
- Agent API keys are SHA-256 hashed; timing-safe comparison.
- Budget enforcement uses `spent + reserved` atomically — concurrent requests cannot collectively overspend.
- Confirmation amount is read from the DB (never from the caller).
- Idempotency keys are scoped to `(agent_id, idempotency_key)`.
- CORS restricted to an explicit origin allowlist.
- Full audit trail: every state change is logged with actor and IP.

See `docs/security-review.md` for the complete audit and remediation record.

---

## Sample agent client

```bash
AGENTPAY_API_KEY=apk_... bun run docs/sample-agent-client.ts
```

Demonstrates a permitted payment, a rejected payment, and a revocation.

---

## Troubleshooting

**"Autonomous execution not configured"** — add `CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET` to `.env` and restart the server.

**"Agent has no provisioned wallet"** — call `POST /api/agents/:id/provision-wallet` first.

**Payments stuck in AUTHORIZED** — either call `/execute` (DCW) or `/submit` + `/confirm` (manual flow with a real tx hash).

**CORS errors in browser** — add your frontend URL to `ALLOWED_ORIGIN` in `.env` and restart the server.
