# Sprint 3 — Autonomous Payment Setup

AgentPay can execute USDC payments **without a MetaMask popup** using Circle
Developer-Controlled Wallets (DCW). Each agent gets its own EOA wallet on
Arc Testnet; the server signs transfers server-side using Circle's custody
infrastructure.

## Architecture

```
  Agent API call
       │
       ▼
  POST /api/payments/request          ← policy check (budget, limits, allowlists)
       │                                  → status: AUTHORIZED, reservation placed
       ▼
  POST /api/payments/:id/execute      ← agent-authenticated (API key)
       │  reads amount from DB only
       │  calls Circle createTransaction
       │  polls until COMPLETE / FAILED
       ▼
  CONFIRMED — tx_hash + explorer link returned
```

### What is enforced where

| Constraint | Enforced | Where |
|---|---|---|
| Per-transaction cap | ✓ | Backend policy engine |
| Budget ceiling | ✓ | Backend (reserved_usdc + spent_usdc) |
| Daily / monthly limits | ✓ | Backend policy engine |
| Recipient allowlist | ✓ | Backend policy engine |
| Duplicate prevention | ✓ | DB UNIQUE + Circle idempotency key |
| Revocation blocks execution | ✓ | Policy engine (agent.status check) |
| On-chain spending limit | ✗ | **Not enforced on-chain (MVP limitation)** |

The practical ceiling for an agent is the USDC balance of its provisioned
wallet — it cannot spend more than what was deposited, regardless of what the
backend policy says.

## Prerequisites

1. A Circle developer account at https://console.circle.com
2. A Circle Standard Developer API key
3. A registered entity secret

## Step 1 — Add credentials to `.env`

```bash
CIRCLE_API_KEY=<your-api-key>
CIRCLE_ENTITY_SECRET=<your-32-byte-hex-entity-secret>
```

Both values are **server-side only** — never expose them to the frontend or
to agent code.

## Step 2 — Register entity secret (first time only)

If you have not yet registered an entity secret for your Circle account, Arc
Studio can do this for you. Type:

```
register my Circle entity secret
```

in the Arc Studio chat. This will generate a 32-byte secret, register its
ciphertext with Circle's API, write `CIRCLE_ENTITY_SECRET` to `.env`, and
prompt you to download the recovery file. Store the recovery file outside the
repository.

## Step 3 — Provision a wallet for each agent

```bash
curl -X POST http://localhost:3001/api/agents/<agent-id>/provision-wallet \
  -H "Authorization: Bearer <your-jwt>"
```

Response:
```json
{
  "wallet_id": "uuid",
  "wallet_address": "0x...",
  "explorer_url": "https://explorer.testnet.arc.io/address/0x...",
  "funding_note": "Fund this address with USDC on Arc Testnet..."
}
```

## Step 4 — Fund the wallet

Get test USDC from the Arc Studio sidebar ("Get test USDC"), then send it to
the agent's `wallet_address`. The wallet must hold at least the agent's
`budget_usdc` setting in USDC to execute payments.

## Step 5 — Execute payments autonomously

```bash
# 1. Request a payment (agent API key)
curl -X POST http://localhost:3001/api/payments/request \
  -H "Authorization: Bearer apk_<agent-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"recipient":"0x...","amount_usdc":"0.05","purpose":"api","idempotency_key":"unique-key-001"}'

# 2. Execute autonomously (agent API key — no MetaMask needed)
curl -X POST http://localhost:3001/api/payments/<payment-id>/execute \
  -H "Authorization: Bearer apk_<agent-api-key>"
```

The response includes `tx_hash` and `explorer_url` when CONFIRMED.

## Limitations (MVP)

- Spending limits are enforced by the backend only, not on-chain.
- A compromised server could theoretically bypass them.
- The practical ceiling is the wallet's USDC balance.
- Webhook-based confirmation (instead of polling) is not yet implemented.
- Multi-network support is not yet implemented (Arc Testnet only).
- Smart contract wallet (on-chain spending limits) is a planned future feature.
