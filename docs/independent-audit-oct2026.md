# AgentPay — Independent Security Audit
**Date:** October 23, 2026  
**Auditor:** Independent senior application security engineer  
**Scope:** Sprint 1+2 remediation claims, Sprint 3 DCW architecture, full codebase  
**Methodology:** Code review + live adversarial testing against isolated temp-DB server instances  
**Application code modified:** None  

---

## 1. Executive Verdict

**CONDITIONAL PASS — Sprint 3 may proceed after resolving F-01 and F-02.**

The six Sprint 1+2 Critical/High findings are confirmed remediated. The concurrent budget exploit, amount-injection exploit, and cross-agent idempotency collision all fail against the current code. However, two new **High** findings were discovered by adversarial testing that were not present or not tested in the previous audit cycle. These must be resolved before Sprint 3 adds DCW autonomous execution (which gives the spending limits real financial consequence).

Three additional Medium findings and four Low/Informational findings are documented below.

---

## 2. Findings Table

### F-01 — **HIGH** — Policy bypass via `Infinity` / `NaN` budget values
| Field | Value |
|---|---|
| **Severity** | High |
| **File** | `server/routes/agents.ts` line 93–110, `server/policy.ts` line 27 |
| **Status** | **NEW — NOT previously found or tested** |

**Exploit preconditions:** Owner is authenticated (JWT or dev fallback). Owner calls `PATCH /api/agents/:id/policy` with `{"budget_usdc":"Infinity","max_per_tx_usdc":"Infinity","daily_limit_usdc":"Infinity","monthly_limit_usdc":"Infinity"}`.

**Demonstrated exploit (A8b):**
```
PATCH /api/agents/<id>/policy  {"budget_usdc":"Infinity",...all limits "Infinity"}
POST /api/payments/request     {"amount_usdc":"999999"}
→ status: AUTHORIZED   ← policy passes all budget checks
```

**Root cause:** `parseFloat("Infinity") === Infinity` in JavaScript. The policy engine function `n(v)` is `parseFloat(v) || 0` — but `parseFloat("Infinity")` is truthy, so it returns `Infinity`, not `0`. All budget comparisons (`amount <= Infinity`) are trivially true. No validation exists in the PATCH handler or agent creation path to reject non-finite numeric strings.

**Impact:** Owner can configure an agent with effectively unlimited spending authority. When DCW execution is live (Sprint 3), this means the agent's wallet USDC balance is the only real ceiling — the policy engine provides no protection. An agent with a $10,000 funded wallet and `budget_usdc: "Infinity"` can drain it in a single payment request.

**Recommended fix:**
```typescript
// In agents.ts, add to PATCH handler and POST creation:
const NUMERIC_FIELDS = ['budget_usdc','max_per_tx_usdc','daily_limit_usdc',
                        'monthly_limit_usdc','require_approval_above_usdc']
for (const field of NUMERIC_FIELDS) {
  if (field in p) {
    const v = parseFloat(String(p[field]))
    if (!isFinite(v) || v < 0) {
      res.status(400).json({ error: `${field} must be a finite non-negative number` }); return
    }
  }
}
// Also enforce a maximum (e.g., 1,000,000 USDC) to prevent absurd values.
```

**Test needed:** PATCH with `"Infinity"`, `"NaN"`, `"-1"`, `"1e999"` for each numeric policy field. Assert 400. Assert policy correctly rejects $0.01 payment after a bad value is stored.

---

### F-02 — **HIGH** — `/fail` endpoint accepts terminal payment states
| Field | Value |
|---|---|
| **Severity** | High |
| **File** | `server/routes/payments.ts` lines 271–295 |
| **Status** | **NEW — NOT previously found or tested** |

**Exploit preconditions:** Owner is authenticated. Payment is in CONFIRMED or REJECTED state.

**Demonstrated exploit (A3):**
```
POST /api/payments/<confirmed-payment-id>/fail  {"error_message":"retroactive fail"}
→ HTTP 200  {"success":true,"status":"FAILED"}
Payment record in DB now shows status=FAILED instead of CONFIRMED
```

**Root cause:** The `/fail` endpoint reads `priorStatus` and sets `releaseable` correctly (CONFIRMED is not releaseable), so `reserved_usdc` and `spent_usdc` accounting is not corrupted. However, there is **no guard preventing the status UPDATE from running on a terminal state**. The `db.run("UPDATE payments SET status='FAILED'...")` executes unconditionally.

**Impact:** An owner (or anyone who can authenticate as the owner) can overwrite a CONFIRMED payment's status to FAILED. This destroys the audit trail, breaks reconciliation with on-chain state, and could be used to re-submit a payment for a service that checks for CONFIRMED status before delivering. `spent_usdc` stays correct (the `releaseable` guard prevents double-release), but the payment record no longer reflects reality. In the DCW context, the on-chain transfer has already settled; marking it FAILED in the DB is a lie.

**Recommended fix:**
```typescript
// Add terminal state guard at the top of the /fail handler:
const TERMINAL_STATES = ['CONFIRMED', 'FAILED', 'REJECTED']
if (TERMINAL_STATES.includes(payment.status as string)) {
  res.status(409).json({ 
    error: `Cannot fail a payment in terminal state ${payment.status as string}` 
  }); return
}
```

**Test needed:** Authorize → submit → confirm → attempt fail. Assert 409. Also: Authorize → reject → attempt fail. Assert 409.

---

### F-03 — **MEDIUM** — SIWE domain not validated server-side
| Field | Value |
|---|---|
| **Severity** | Medium |
| **File** | `server/auth.ts` line 171 |
| **Status** | **NEW — partially mitigated by nonce consumption** |

**Root cause:** `siweMsg.verify({ signature })` is called without passing `domain` in `VerifyParams`. Per the siwe v3 source code (verified in `node_modules/siwe/dist/client.js`):
```javascript
if (domain && domain !== this.domain) { fail(...) }  // only runs if domain is in params
```
Without `domain` in params, the library does **not** check that the SIWE message's domain matches the server's domain. A valid signature over a message with `domain: evil.com` will pass the library's signature check.

**Practical exploit preconditions (HIGH bar):** Attacker must obtain a valid SIWE signature from the target user on a different website that also uses SIWE and whose nonce happened to match one of AgentPay's valid nonces. This requires a compromised third-party site AND a nonce collision (128-bit nonces, near-impossible). Additionally, the nonce is consumed on first use — a replayed message cannot be reused. The practical risk is low **today** but represents a specification deviation and creates latent risk if nonce generation is weakened or the nonce is leaked.

**Recommended fix:**
```typescript
verifyResult = await siweMsg.verify({ 
  signature,
  domain: process.env.SIWE_DOMAIN ?? new URL(process.env.ALLOWED_ORIGIN ?? 'http://localhost:5173').hostname,
  nonce: siweMsg.nonce,   // explicit: forces library-level nonce check in addition to server-side check
})
```

**Test needed:** Send a valid SIWE message with `domain: evil.com` and a valid server-issued nonce. Without the fix, this would succeed if a real wallet signed it. With the fix, the library rejects domain mismatch.

---

### F-04 — **MEDIUM** — Dev auth fallback active in any non-`production` environment
| Field | Value |
|---|---|
| **Severity** | Medium |
| **File** | `server/auth.ts` lines 100–110 |
| **Status** | Pre-existing, now formally documented |

**Finding:** `requireOwnerJwt` accepts `X-Owner-Address` as a valid identity proof when `NODE_ENV !== 'production'`. This means any deployment where `NODE_ENV` is `undefined`, `staging`, `development`, `test`, or any other value bypasses JWT authentication entirely. Anyone who can send an HTTP request can authenticate as any Ethereum address.

**Verified (A9):** `GET /api/agents` with `X-Owner-Address: <any_address>` returns `HTTP 200` on the test server (`NODE_ENV=test`).

**Impact class:** If a staging deployment is reachable from the internet (common in SaaS development), this is an **authentication bypass** — not a dev convenience. The fallback is also present in the existing tests: the test suite relies entirely on `X-Owner-Address` and does not exercise the JWT code path for agent/payment operations, meaning the JWT middleware is **only tested via `/api/auth/me`**.

**Recommended fix (two parts):**
1. Replace `NODE_ENV !== 'production'` with an explicit `ALLOW_HEADER_AUTH=true` env flag. Remove it from any non-local deployment.
2. Add test coverage that exercises JWT-authenticated routes (not just `/api/auth/me`).

---

### F-05 — **MEDIUM** — 413 Payload Too Large returns 500
| Field | Value |
|---|---|
| **Severity** | Medium |
| **File** | `server/index.ts` line 125–132 (error handler) |
| **Status** | NEW |

**Finding:** When a request body exceeds the 64KB `express.json` limit, Express throws a `PayloadTooLargeError`. The catch-all error handler does not distinguish this from a 500 Internal Server Error, returning `{"error":"Internal server error"}` with HTTP 500 instead of HTTP 413. This is confirmed in test A17 and server logs.

**Impact:** Misleads clients about the actual failure reason. A client retrying on 500 will retry indefinitely on a request that will always be too large. Information about the 64KB limit is not exposed, which slightly reduces debuggability but does not increase risk.

**Recommended fix:**
```typescript
app.use((err: Error & { status?: number; type?: string }, _req, res, _next) => {
  if (err.status === 413 || err.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body too large (max 64KB)' }); return
  }
  if (err.message?.startsWith('CORS:')) {
    res.status(403).json({ error: 'Forbidden' }); return
  }
  console.error('[server]', err)
  res.status(500).json({ error: 'Internal server error' })
})
```

---

### F-06 — **LOW** — JWT secret is ephemeral (not persisted)
| Field | Value |
|---|---|
| **Severity** | Low |
| **File** | `server/auth.ts` line 32 |
| **Status** | Pre-existing, design choice |

**Finding:** `JWT_SECRET_KEY = new Uint8Array(randomBytes(32))` is generated fresh at each server start. Every server restart invalidates all existing sessions. Users must re-authenticate after every deploy or crash.

**Impact:** This is a legitimate design choice (documented in comments: "Rotating this invalidates all existing sessions, which is the desired behaviour on server restart"). The practical impact is usability friction, not a security risk. However, in a multi-instance deployment, all instances must share the secret.

**Recommended fix:** Read from `process.env.JWT_SECRET` (minimum 32 bytes, base64-encoded). Fall back to random only if absent and `NODE_ENV !== 'production'`.

---

### F-07 — **LOW** — `requireAgentApiKey` timing-safe comparison is redundant
| Field | Value |
|---|---|
| **Severity** | Low / Informational |
| **File** | `server/auth.ts` lines 127–135 |
| **Status** | Defense-in-depth redundancy |

**Finding:** The middleware hashes the provided key with SHA-256, queries the DB for a matching hash, then calls `timingSafeEqual` on the hash vs. the same hash. This is correct but redundant — `timingSafeEqual` is comparing two values that are already equal (because the DB query matched) or the middleware already returned 401 (miss). The DB query itself is not constant-time (it short-circuits on miss), meaning the `timingSafeEqual` call does not prevent timing attacks through the DB lookup path.

**Impact:** Very low. SHA-256 pre-images are computationally infeasible. The `timingSafeEqual` call provides no additional protection over the DB query but causes no harm.

**Recommended fix:** Either remove the now-redundant `timingSafeEqual` call (relying on SHA-256 pre-image resistance) or restructure to always do a dummy comparison on miss.

---

### F-08 — **LOW** — `audit_log.detail` stores raw policy updates without scrubbing
| Field | Value |
|---|---|
| **Severity** | Low |
| **File** | `server/routes/agents.ts` line 111 |
| **Status** | Informational |

**Finding:** `auditLog({ detail: JSON.stringify(p) })` on `PATCH /policy` stores the full patch body in the audit log. This includes all policy field values, which is appropriate. However, if any unexpected fields are passed (not in the `allowed` list), they are not stored (filtered out by the `for (const key of allowed)` loop) — but the raw body `p` passed to `JSON.stringify` is the unfiltered input. This means keys outside the allowlist **do** appear in the audit log even though they are not applied to the DB.

**Impact:** Minimal — audit log contains extra fields. No security consequence today; if a future field like `circle_wallet_id` were added to `allowed`, this would auto-log it too.

---

## 3. Verified Controls (Sprint 1+2 claims)

| Claim | Verification method | Result |
|---|---|---|
| Concurrent 22×$0.05 against $1.00 budget: max 20 authorized | Re-ran `security.test.ts` CRITICAL-1 test | **Confirmed. Pass.** |
| `confirm` ignores caller's `amount_usdc` | Code review (payment.ts line 238) + CRITICAL-3 test | **Confirmed. Pass.** |
| `(agent_id, idempotency_key)` unique constraint | DB schema + HIGH-2 test suite | **Confirmed. Pass.** |
| CORS rejects unlisted origins | Code review + adversarial test A12 + HIGH-3 test | **Confirmed. Pass.** |
| `X-Owner-Address` on `/api/auth/me` returns 401 | CRITICAL-2 test + adversarial test A9 | **Confirmed. Pass (on /auth/me only).** |
| SIWE nonce is single-use | `consumeNonce()` code review (UPDATE with `used=0` guard) + test | **Confirmed. Pass.** |
| Agent revocation immediately blocks payments | Revocation test + adversarial logic | **Confirmed. Pass.** |
| Cross-owner agent access returns 404 | Adversarial test A12 | **Confirmed. Pass.** |
| Cross-owner payment access returns 404 | Cross-owner test in security.test.ts | **Confirmed. Pass.** |
| Double-reject returns 409 | Adversarial test A16 | **Confirmed. Pass.** |
| Double-confirm returns 409 | CRITICAL-3 double-confirm test | **Confirmed. Pass.** |
| Concurrent `/fail` calls do not make reserved_usdc negative | Adversarial test A14 + MAX(0,...) guard | **Confirmed. Pass.** |
| SQL injection via PATCH: no crash | Adversarial test A5 (parameterized queries) | **Confirmed. Pass.** |

---

## 4. Test Results

### Commands executed

```bash
# Baseline checks (no app code changes):
bun run check
# → 12 warnings, 0 errors. Typecheck clean.

# Full test suite:
bun test server/tests/policy.test.ts server/tests/security.test.ts server/tests/flows.test.ts --timeout 60000
# → 61 pass, 0 fail, 139 expect() calls. 880ms.

# Adversarial tests (isolated server: PORT=3097, fresh temp-DB, NODE_ENV=test):
# A1–A18 executed manually, results documented in section 3 and findings above.
# Server killed after adversarial tests; no persistent state changes.
```

### Environment

- No git repository (sandbox project). Diff from previous session: N/A.
- Dev server running on port 5173 (Vite). Adversarial server on port 3097 (killed after tests).
- No ports 3098/3099 running at audit start.
- `NODE_ENV=test` for all test runs (intentional — enables dev fallback, which is itself a finding).

---

## 5. Residual Risks

| Risk | Status |
|---|---|
| On-chain spending limits not enforced | Documented design limitation. The agent wallet's USDC balance is the practical ceiling. This is acceptable for MVP given F-01 is fixed. |
| JWT secret not persisted across restarts | Low risk (F-06). Users re-authenticate. |
| SIWE domain not validated by library | Medium risk (F-03). Server-side nonce consumption partially mitigates. |
| No rate limiting on `/fail`, `/reject`, `/approve` | State-machine guards (409 on invalid state) prevent abuse. Low risk. |
| `agentpay.db` file permissions | Not audited. In production, the DB file should be chmod 600. |
| Circle DCW credentials in `.env` | Not yet present in sandbox. When set, must be server-side only. Currently correctly gated behind `isDcwConfigured()`. |
| `trust proxy: 1` set without confirming proxy topology | If deployed without a proxy, the `X-Forwarded-For` header is spoofable, affecting rate limiting by IP. |

---

## 6. Prioritized Remediation Plan

### P0 — Must fix before Sprint 3 (DCW execution adds real financial risk)

**F-01: Infinity/NaN budget bypass**
- Add `isFinite(v) && v >= 0` validation to all numeric policy fields in both `POST /api/agents` and `PATCH /:id/policy`.
- Add an upper bound (e.g., $1,000,000 USDC) to prevent absurd values.
- Regression test: assert 400 for `"Infinity"`, `"NaN"`, `"-1"`, `"1e999"`, `""`.

**F-02: `/fail` accepts CONFIRMED/REJECTED payments**
- Add terminal state guard: `if (['CONFIRMED','FAILED','REJECTED'].includes(priorStatus)) → 409`.
- Regression test: full flow → confirm → fail → assert 409.

### P1 — Fix in Sprint 3 (before any production or testnet real-funds use)

**F-03: SIWE domain not validated**
- Pass `domain` in `verify()` params. Source it from `SIWE_DOMAIN` env var or derive from `ALLOWED_ORIGIN`.
- Test: wrong-domain message with valid nonce → 401.

**F-04: Dev auth fallback in non-`production`**
- Replace `NODE_ENV !== 'production'` with explicit `ALLOW_HEADER_AUTH` env flag.
- Remove the flag from any non-local deployment.
- Add integration tests that hit agent/payment routes with a real JWT (not just `/auth/me`).

**F-05: 413 returns 500**
- Handle `PayloadTooLargeError` specifically in the error handler.

### P2 — Fix before public beta

**F-06: Ephemeral JWT secret**
- Read from `JWT_SECRET` env var. Document the requirement in README and `.env.example`.

**F-07: Redundant `timingSafeEqual`**
- Remove or restructure the redundant comparison. Low priority.

**F-08: Audit log stores unfiltered input keys**
- Pass `Object.fromEntries(setClauses.map(...))` to `auditLog.detail` instead of raw `p`.

---

## 7. Sprint 3 Readiness Checklist

| Requirement | Status |
|---|---|
| F-01 (Infinity budget) fixed and tested | ❌ **BLOCKER** |
| F-02 (`/fail` on terminal states) fixed and tested | ❌ **BLOCKER** |
| F-03 (SIWE domain) fixed or accepted with documented risk | ⚠️ Recommended before real-funds use |
| F-04 (dev fallback) replaced with explicit flag | ⚠️ Recommended before any deployed environment |
| `CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET` provisioned server-side only | ✅ Architecture correct. `isDcwConfigured()` guard present. |
| Entity secret never logged or exposed to frontend | ✅ Verified: only read via `process.env`, never returned from any API endpoint. |
| DCW amount sourced from DB (not caller) | ✅ Verified: `payments.ts` line 344 `const amountUsdc = payment.amount_usdc as string`. |
| Circle idempotency key prevents duplicate on-chain transfers | ✅ Verified: `agentpay-${opts.paymentId}` scoped to payment UUID. |
| Budget checked before `createTransaction` call | ✅ Verified: policy check runs inside DB transaction at authorization time. |
| Reservation released on DCW failure | ✅ Verified: `releaseReservation` called in failure branch of `/execute`. |
| Wallet credentials never sent to agent or frontend | ✅ Verified: no Circle credentials in any API response. |
| Sprint 3 spending-limit limitation documented | ✅ Documented in `dcw.ts` header and `docs/security-review.md`. |

**Decision:** Do not merge Sprint 3 DCW execution until F-01 and F-02 are fixed and their regression tests pass.
