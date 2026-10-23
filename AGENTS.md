# AgentPay — Project Memory

> Built with Arc Studio — https://studio.arc.io

## What This App Does

AgentPay is a programmable USDC wallet for AI agents. It provides a policy engine, agent management dashboard, and authenticated payment API on Arc Testnet. Agents request payments via Bearer-authenticated REST endpoints; the backend validates policy atomically; users approve edge cases and execute USDC transfers from their own wallet.

## Tech Stack

- **Frontend**: React 18, Vite, TypeScript, Tailwind CSS
- **Web3**: wagmi v2, viem v2, ConnectKit
- **Backend**: Express 5 on port 3001, Bun runtime
- **Database**: SQLite via `bun:sqlite`, WAL mode, at `agentpay.db`
- **Chain**: Arc Testnet (Chain ID 5042002, imported from `viem/chains`)
- **Token**: USDC (6 decimals, ERC-20: 0x3600000000000000000000000000000000000000)
- **Toasts**: Sonner

## Key Files

| Path | Purpose |
|---|---|
| `src/App.tsx` | Root — mounts layout and routes to page views |
| `src/components/Layout.tsx` | Sidebar nav, topbar, ConnectKitButton |
| `src/components/OverviewPage.tsx` | Balance, agent budget bars, recent payments |
| `src/components/AgentsPage.tsx` | Create, pause, resume, revoke agents |
| `src/components/AgentDetailPage.tsx` | Budget, policy, allowlists, payment history |
| `src/components/PaymentsPage.tsx` | Approve/reject/execute payments, state machine UI |
| `src/components/PolicyPage.tsx` | Bulk policy configuration |
| `src/components/DeveloperPage.tsx` | API docs, cURL/TS examples, state machine diagram |
| `src/lib/api.ts` | Typed API client (sets X-Owner-Address automatically) |
| `src/lib/utils.ts` | formatUsdc, formatAddress, statusColor, relativeTime |
| `src/hooks/useAgents.ts` | TanStack Query wrappers for agent CRUD |
| `src/hooks/usePayments.ts` | TanStack Query wrappers for payment operations |
| `server/index.ts` | Express 5 entry point, rate limiting |
| `server/db.ts` | bun:sqlite setup, WAL mode, schema |
| `server/auth.ts` | SHA-256 API key hashing, owner-address validation |
| `server/policy.ts` | All 8 spending policy rules — stateless, fail-closed |
| `server/audit.ts` | Append-only audit log writer |
| `server/routes/agents.ts` | Agent CRUD endpoints |
| `server/routes/payments.ts` | Payment state machine endpoints |

## Architecture Decisions

1. **No server-held keys** — the server validates policy and tracks state; wallet signs all transfers.
2. **bun:sqlite** — chosen over better-sqlite3 (requires node-gyp) and Postgres (overkill for MVP); WAL mode for crash safety.
3. **SHA-256 API keys** — no bcrypt needed; keys are random 36-char strings making preimage attack infeasible.
4. **Idempotency at the DB layer** — `UNIQUE(idempotency_key)` constraint prevents race conditions from retry storms.
5. **Budget deduction only on CONFIRMED** — prevents double-charging on RPC failures or resubmits.
6. **Vite proxy for /api** — sandbox preview only exposes port 5173; backend on 3001 is reached via proxy.
7. **X-Owner-Address auth** — MVP session-less pattern; production should use SIWE (Sign-In With Ethereum).

## Contract Deployments

None yet. Phase 3 (Arc Testnet payments) uses direct ERC-20 USDC transfers from the user's wallet — no custom contract required for the MVP.

## To Run

```bash
bun install
# Terminal 1
bun run server
# Terminal 2
bun run dev
```

## Limitations and Future Work

- **Manual execution**: user must click "Execute Transfer" for each authorized payment. Future: ERC-4337 smart wallet with on-chain spending policy.
- **SIWE auth**: replace X-Owner-Address with Sign-In With Ethereum for production.
- **Webhook notifications**: alert agents when payment status changes.
- **Multi-chain**: extend to Base, Ethereum Sepolia, etc.
- **x402 integration**: make AgentPay compatible with Circle's x402 micropayment standard.
