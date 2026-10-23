# AgentPay Security Audit & Remediation Record

**Last updated:** Sprint 4 complete  
**Test suite:** 61/61 passing across 3 files

---

## Confirmed Findings — Remediation Status

| ID | Severity | Title | Status | Fix commit |
|----|----------|-------|--------|------------|
| CRITICAL-1 | Critical | Concurrent budget overspend (no reservation) | **Fixed** | Sprint 1 |
| CRITICAL-2 | Critical | Unauthenticated owner identity (forged X-Owner-Address) | **Fixed** | Sprint 1 |
| CRITICAL-3 | Critical | Caller-controlled confirmation amount ($9999 exploit) | **Fixed** | Sprint 1 |
| HIGH-1 | High | No autonomous execution (MetaMask required for every tx) | **Fixed** | Sprint 3 |
| HIGH-2 | High | Idempotency key not scoped to agent (cross-agent collision) | **Fixed** | Sprint 2 |
| HIGH-3 | High | CORS `origin: true` mirrors any origin | **Fixed** | Sprint 2 |

---

## CRITICAL-1: Concurrent Budget Overspend

**Exploit reproduced:** 22 concurrent × $0.05 against a $1.00 budget → 22 AUTHORIZED ($1.10 committed).

**Fix:** Added `reserved_usdc` column to `agents` table. The policy engine now
checks `budget − spent − reserved` instead of `budget − spent`. The INSERT +
reservation UPDATE run in a single SQLite transaction, so concurrent requests
cannot read a stale `reserved_usdc`. On terminal failure, the reservation is
released atomically in the same transaction.

**Regression test:** `security.test.ts` → "concurrent requests cannot collectively exceed budget"

---

## CRITICAL-2: Unauthenticated Owner Identity

**Exploit reproduced:** Any address in `X-Owner-Address` header was trusted without verification.

**Fix:** Full SIWE (Sign-In with Ethereum / EIP-4361) authentication:
- `GET /api/auth/nonce` issues a 128-bit random nonce, stored in `siwe_nonces` table with 5-min TTL.
- `POST /api/auth/verify` verifies the EIP-191 signature, domain, chain ID, expiry, and consumes the nonce (single-use).
- A short-lived HS256 JWT (8hr) is issued. All owner-protected routes require `Authorization: Bearer <jwt>`.
- `X-Owner-Address` fallback remains active in non-production environments only, for development convenience.

**Regression test:** `security.test.ts` → "forged X-Owner-Address without JWT is rejected in production mode"

---

## CRITICAL-3: Caller-Supplied Amount on Confirmation

**Exploit reproduced:** `POST /payments/:id/confirm` with `amount_usdc: 9999` corrupted `spent_usdc` to $9,999.

**Fix:** The `/confirm` endpoint now completely ignores the `amount_usdc` field from
the request body. The authoritative amount is always read from `payments.amount_usdc`
in the database, which was validated and policy-checked at request time and is immutable.

**Regression test:** `security.test.ts` → "confirm ignores amount_usdc from request body (reproduces $9999 exploit)"

---

## HIGH-1: No Autonomous Execution

**Original finding:** Every USDC transfer required a MetaMask popup. Agents could
not pay anything without a human in the browser.

**Fix (Sprint 3):** Per-agent Circle Developer-Controlled Wallet (DCW) architecture:
- `POST /api/agents/:id/provision-wallet` creates a dedicated EOA wallet on ARC-TESTNET via Circle's DCW API.
- `POST /api/payments/:id/execute` (agent API-key authenticated) calls `circle.createTransaction`, polls for COMPLETE/FAILED, and updates the payment state machine atomically.
- The Circle API key and entity secret are server-side env vars; never exposed to the frontend or AI agents.
- Circle's idempotency key on `createTransaction` prevents duplicate on-chain transfers on retry.

**Documented limitation:** Spending limits are backend-enforced only (policy engine).
The practical ceiling is the wallet's actual USDC balance. On-chain enforcement
(e.g. SCA with spending limits) is planned for a future release.

**Setup:** See `docs/sprint3-setup.md`.

---

## HIGH-2: Idempotency Key Not Scoped to Agent

**Exploit reproduced:** Agent B using the same `idempotency_key` as Agent A received Agent A's payment object.

**Fix:** Changed the unique constraint from `UNIQUE(idempotency_key)` to
`UNIQUE(agent_id, idempotency_key)`. Added a live migration that detects the
old global constraint and rebuilds the `payments` table with the correct constraint.
Race conditions at the DB level are handled by catching `UNIQUE constraint failed`
and re-reading the existing record.

**Regression test:** `security.test.ts` → "same key for different agents creates independent payments"

---

## HIGH-3: CORS Origin Reflection

**Exploit reproduced:** `Origin: https://evil-hacker.com` received a matching `Access-Control-Allow-Origin`.

**Fix:** Replaced `origin: true` with an explicit callback that checks against
`ALLOWED_ORIGINS` (hard-coded dev origins + optional env vars `ALLOWED_ORIGIN`
and `PRODUCTION_ORIGIN`). Requests from unlisted origins receive a 403 with no
CORS headers. `X-Owner-Address` header removed from `allowedHeaders` (now JWT-based).

**Regression test:** `security.test.ts` → "disallowed origin does not receive ACAO header"

---

## Remaining Risks and Architectural Limitations

### MVP Limitations (documented, not bugs)

1. **Backend-only spending limits.** The policy engine is the only layer
   enforcing per-tx caps and budget limits. A compromised server could bypass
   them. The practical ceiling is the DCW wallet's balance.
   *Mitigation planned: SCA wallet with on-chain allowances.*

2. **JWT secret rotates on server restart.** All sessions are invalidated
   when the server restarts because the secret is generated fresh in memory.
   *Acceptable for MVP; production should use a persistent secret from a
   secrets manager.*

3. **X-Owner-Address fallback in non-production.** This is intentionally kept
   for development ergonomics. The production CORS allowlist and JWT requirement
   protect real deployments.

4. **SQLite single-process.** The WAL + FULL-synchronous config is crash-safe
   but limits horizontal scaling. For multi-instance deployments, migrate to
   Postgres with row-level locking.

5. **No webhook support.** Circle transaction confirmations are polled
   synchronously in the `/execute` request. Long-running chains may time out.
   *Async job + webhook is planned.*

---

## Test Coverage Summary

| File | Tests | Covers |
|------|-------|--------|
| `security.test.ts` | 19 | All 6 confirmed exploits + input validation + revocation |
| `flows.test.ts` | 12 | Full state machine, MVP acceptance criteria, DCW unconfigured |
| `policy.test.ts` | 30 | All 8 policy rules, edge cases, CRITICAL-1 reservation logic |
| **Total** | **61** | |

Run all tests: `bun test server/tests/`
