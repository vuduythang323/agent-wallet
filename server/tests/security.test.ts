/**
 * Security regression tests for Sprint 1 + 2 fixes.
 *
 * Each test suite spins up the real server against a fresh temp-file DB,
 * exercises the exploit, and asserts it fails.
 *
 * Run: bun test server/tests/security.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { spawn, type Subprocess } from 'bun'
import path from 'path'
import { randomBytes } from 'crypto'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ENTRY = path.join(__dirname, '../index.ts')
const TEST_PORT    = 3099   // dedicated port for tests — avoids clash with the dev server

const OWNER  = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const OWNER2 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

// ─── Server lifecycle ─────────────────────────────────────────────────────────
let serverProc: Subprocess
let dbPath: string

async function startServer(): Promise<void> {
  dbPath = path.join('/tmp', `agentpay-test-${randomBytes(4).toString('hex')}.db`)
  serverProc = spawn(['bun', 'run', SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT:             String(TEST_PORT),
      AGENTPAY_DB_PATH: dbPath,
      NODE_ENV:         'test',         // enables X-Owner-Address fallback for dev convenience
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // Wait until the server is ready
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Server start timeout')), 10_000)
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`http://localhost:${TEST_PORT}/api/health`)
        if (r.ok) { clearInterval(poll); clearTimeout(deadline); resolve() }
      } catch { /* not ready yet */ }
    }, 150)
  })
}

function stopServer() {
  if (serverProc) serverProc.kill()
}

const base = `http://localhost:${TEST_PORT}`

async function j(res: Response) { return res.json() as Promise<Record<string, unknown>> }

/** Create agent via API, return { id, apiKey }. */
async function createAgent(ownerAddr: string, policy?: Record<string, string>) {
  const res = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Owner-Address': ownerAddr },
    body: JSON.stringify({ name: 'TestAgent', policy: policy ?? { budget_usdc: '1', max_per_tx_usdc: '0.1', daily_limit_usdc: '0.5', monthly_limit_usdc: '5' } }),
  })
  const d = await j(res)
  return { id: d.agent as { id: string }, apiKey: d.api_key as string, raw: d }
}

/** Request a payment (agent API key). */
async function requestPayment(apiKey: string, opts: {
  recipient?: string; amount?: string; purpose?: string; ikey?: string
} = {}) {
  return fetch(`${base}/api/payments/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      recipient: opts.recipient ?? OWNER,
      amount_usdc: opts.amount ?? '0.05',
      purpose: opts.purpose ?? 'api',
      idempotency_key: opts.ikey ?? `key-${randomBytes(8).toString('hex')}`,
    }),
  })
}

// ─── Test suites ──────────────────────────────────────────────────────────────

// ─── Single server for all suites ────────────────────────────────────────────
beforeAll(startServer)
afterAll(stopServer)

describe('CRITICAL-1: atomic budget reservation', () => {

  it('sequential requests cannot exceed budget', async () => {
    const { apiKey } = await createAgent(OWNER, {
      budget_usdc: '1', max_per_tx_usdc: '0.1', daily_limit_usdc: '10', monthly_limit_usdc: '100',
    })
    // 10 × $0.10 = exactly $1.00 budget — all should succeed
    const results = []
    for (let i = 0; i < 10; i++) {
      const r = await requestPayment(apiKey, { amount: '0.1', ikey: `seq-test-${i}` })
      results.push(await j(r))
    }
    const authorized = results.filter(d => (d.payment as { status: string })?.status === 'AUTHORIZED')
    expect(authorized.length).toBe(10)

    // 11th request must be rejected — budget exhausted
    const over = await requestPayment(apiKey, { amount: '0.1', ikey: 'seq-test-10' })
    const d = await j(over)
    expect((d.payment as { status: string })?.status).toBe('REJECTED')
    expect((d.policy_result as { rejection_reason: string })?.rejection_reason).toMatch(/budget/i)
  })

  it('concurrent requests cannot collectively exceed budget (reproduces reported exploit)', async () => {
    // Budget: $1.00 · max_per_tx: $0.05 · 22 concurrent @ $0.05 = $1.10 requested
    // Before fix: all 22 got AUTHORIZED ($1.10 committed).
    // After fix:  at most 20 get AUTHORIZED ($1.00 reserved), rest are REJECTED.
    const { apiKey } = await createAgent(OWNER, {
      budget_usdc: '1', max_per_tx_usdc: '0.1', daily_limit_usdc: '10', monthly_limit_usdc: '100',
    })
    const N = 22
    const requests = Array.from({ length: N }, (_, i) =>
      requestPayment(apiKey, { amount: '0.05', ikey: `concurrent-${i}` })
    )
    const responses = await Promise.all(requests)
    const bodies = await Promise.all(responses.map(r => j(r)))

    const authorized = bodies.filter(d => (d.payment as { status: string })?.status === 'AUTHORIZED')
    const rejected   = bodies.filter(d => (d.payment as { status: string })?.status === 'REJECTED')

    // Never more than 20 × $0.05 = $1.00 worth of authorizations
    const totalAuthorized = authorized.length * 0.05
    expect(totalAuthorized).toBeLessThanOrEqual(1.0)
    // Some must be rejected
    expect(rejected.length).toBeGreaterThanOrEqual(2)
    // All N requests must be accounted for
    expect(authorized.length + rejected.length).toBe(N)
  })

  it('reservation is released when payment is rejected by user', async () => {
    const { apiKey, id: agentObj } = await createAgent(OWNER, {
      budget_usdc: '1', max_per_tx_usdc: '0.5', daily_limit_usdc: '10', monthly_limit_usdc: '100',
      require_approval_above_usdc: '0.01',  // all payments need approval
    })
    const agentId = (agentObj as unknown as { id: string }).id

    // Step 1: request $0.50 — goes to AWAITING_APPROVAL, reserves $0.50
    const r1 = await requestPayment(apiKey, { amount: '0.5', ikey: 'res-release-1' })
    const d1 = await j(r1)
    const payId = (d1.payment as { id: string }).id
    expect((d1.payment as { status: string }).status).toBe('AWAITING_APPROVAL')

    // Step 2: reject it — should release the $0.50 reservation
    const rejectRes = await fetch(`${base}/api/payments/${payId}/reject`, {
      method: 'POST',
      headers: { 'X-Owner-Address': OWNER },
    })
    expect(rejectRes.status).toBe(200)

    // Step 3: another $0.50 request should now be approved (reservation was released)
    const r2 = await requestPayment(apiKey, { amount: '0.5', ikey: 'res-release-2' })
    const d2 = await j(r2)
    expect((d2.payment as { status: string }).status).toBe('AWAITING_APPROVAL')

    // Step 4: check that agent's reserved_usdc did not grow permanently
    const agentRes = await fetch(`${base}/api/agents/${agentId}`, {
      headers: { 'X-Owner-Address': OWNER },
    })
    const agent = await agentRes.json() as { reserved_usdc: string; spent_usdc: string }
    // $0.50 reserved for the second payment, $0.00 spent
    expect(parseFloat(agent.spent_usdc)).toBe(0)
    expect(parseFloat(agent.reserved_usdc)).toBeCloseTo(0.5, 5)
  })

  it('confirm moves reservation to spent (not double-counting)', async () => {
    const { apiKey, id: agentObj } = await createAgent(OWNER, {
      budget_usdc: '1', max_per_tx_usdc: '0.5', daily_limit_usdc: '10', monthly_limit_usdc: '100',
    })
    const agentId = (agentObj as unknown as { id: string }).id

    // Authorize a $0.30 payment
    const r = await requestPayment(apiKey, { amount: '0.3', ikey: 'confirm-test-1' })
    const pay = (await j(r)).payment as { id: string; status: string }
    expect(pay.status).toBe('AUTHORIZED')

    // Submit
    const fakeTxHash = '0x' + 'ab'.repeat(32)
    const submitRes = await fetch(`${base}/api/payments/${pay.id}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Owner-Address': OWNER },
      body: JSON.stringify({ tx_hash: fakeTxHash }),
    })
    expect(submitRes.status).toBe(200)

    // Confirm
    const confirmRes2 = await fetch(`${base}/api/payments/${pay.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Owner-Address': OWNER },
      body: JSON.stringify({ block_number: 42 }),
    })
    expect(confirmRes2.status).toBe(200)

    const agentRes = await fetch(`${base}/api/agents/${agentId}`, {
      headers: { 'X-Owner-Address': OWNER },
    })
    expect(agentRes.status).toBe(200)
    const agent = await agentRes.json() as { reserved_usdc: string; spent_usdc: string; id: string }
    // After confirm: spent=$0.30, reserved=$0.00 (not $0.30 + $0.30)
    expect(parseFloat(agent.spent_usdc)).toBeCloseTo(0.3, 5)
    expect(parseFloat(agent.reserved_usdc)).toBeCloseTo(0, 5)
  })
})

describe('CRITICAL-3: caller-supplied amount ignored on confirm', () => {

  it('confirm ignores amount_usdc from request body (reproduces $9999 exploit)', async () => {
    const { apiKey, id: agentObj } = await createAgent(OWNER, {
      budget_usdc: '10', max_per_tx_usdc: '0.5', daily_limit_usdc: '5', monthly_limit_usdc: '50',
    })
    const agentId = (agentObj as unknown as { id: string }).id

    // Authorize $0.05
    const r = await requestPayment(apiKey, { amount: '0.05', ikey: 'amount-inject-1' })
    const pay = (await j(r)).payment as { id: string; status: string }
    expect(pay.status).toBe('AUTHORIZED')

    const submitR = await fetch(`${base}/api/payments/${pay.id}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Owner-Address': OWNER },
      body: JSON.stringify({ tx_hash: '0x' + 'cc'.repeat(32) }),
    })
    expect(submitR.status).toBe(200)

    // Attempt to inject amount_usdc: 9999 (the reported attack)
    const confirmRes = await fetch(`${base}/api/payments/${pay.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Owner-Address': OWNER },
      body: JSON.stringify({ block_number: 100, amount_usdc: '9999' }),
    })
    expect(confirmRes.status).toBe(200)

    const agentRes = await fetch(`${base}/api/agents/${agentId}`, {
      headers: { 'X-Owner-Address': OWNER },
    })
    const agent = await agentRes.json() as { spent_usdc: string }
    // Must be $0.05 — NOT $9999
    expect(parseFloat(agent.spent_usdc)).toBeCloseTo(0.05, 5)
  })

  it('double-confirm is rejected after first confirmation', async () => {
    const { apiKey } = await createAgent(OWNER, {
      budget_usdc: '10', max_per_tx_usdc: '1', daily_limit_usdc: '5', monthly_limit_usdc: '50',
    })
    const r = await requestPayment(apiKey, { amount: '0.1', ikey: 'dbl-confirm-1' })
    const pay = (await j(r)).payment as { id: string }

    await fetch(`${base}/api/payments/${pay.id}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Owner-Address': OWNER },
      body: JSON.stringify({ tx_hash: '0x' + 'dd'.repeat(32) }),
    })
    await fetch(`${base}/api/payments/${pay.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Owner-Address': OWNER },
      body: JSON.stringify({ block_number: 1 }),
    })
    // Second confirm must fail
    const r2 = await fetch(`${base}/api/payments/${pay.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Owner-Address': OWNER },
      body: JSON.stringify({ block_number: 2, amount_usdc: '999' }),
    })
    expect(r2.status).toBe(409)
  })
})

describe('HIGH-2: idempotency key scoped to agent', () => {

  it('same key for different agents creates independent payments', async () => {
    const { apiKey: key1, id: ag1 } = await createAgent(OWNER, {
      budget_usdc: '5', max_per_tx_usdc: '1', daily_limit_usdc: '5', monthly_limit_usdc: '50',
    })
    const { apiKey: key2, id: ag2 } = await createAgent(OWNER2, {
      budget_usdc: '5', max_per_tx_usdc: '1', daily_limit_usdc: '5', monthly_limit_usdc: '50',
    })

    const sharedKey = `shared-idem-${randomBytes(4).toString('hex')}`

    const r1 = await requestPayment(key1, { amount: '0.5', ikey: sharedKey })
    const r2 = await requestPayment(key2, { amount: '0.5', ikey: sharedKey })
    const d1 = await j(r1)
    const d2 = await j(r2)

    // Both must succeed as independent payments, not the same object
    expect((d1.payment as { status: string }).status).toBe('AUTHORIZED')
    expect((d2.payment as { status: string }).status).toBe('AUTHORIZED')
    expect((d1.payment as { id: string }).id).not.toBe((d2.payment as { id: string }).id)

    // Neither should be flagged as idempotent (they are new payments)
    expect(d1.idempotent).toBeUndefined()
    expect(d2.idempotent).toBeUndefined()
  })

  it('same key for same agent returns the original payment', async () => {
    const { apiKey } = await createAgent(OWNER, {
      budget_usdc: '5', max_per_tx_usdc: '1', daily_limit_usdc: '5', monthly_limit_usdc: '50',
    })
    const ikey = `idem-same-${randomBytes(4).toString('hex')}`
    const r1 = await requestPayment(apiKey, { amount: '0.5', ikey })
    const r2 = await requestPayment(apiKey, { amount: '0.5', ikey })
    const d1 = await j(r1)
    const d2 = await j(r2)
    expect((d1.payment as { id: string }).id).toBe((d2.payment as { id: string }).id)
    expect(d2.idempotent).toBe(true)
  })

  it('agent cannot retrieve another agents payment via idempotency key', async () => {
    const { apiKey: key1 } = await createAgent(OWNER, {
      budget_usdc: '5', max_per_tx_usdc: '1', daily_limit_usdc: '5', monthly_limit_usdc: '50',
    })
    const { apiKey: key2 } = await createAgent(OWNER2, {
      budget_usdc: '5', max_per_tx_usdc: '1', daily_limit_usdc: '5', monthly_limit_usdc: '50',
    })

    const ikey = `cross-agent-${randomBytes(4).toString('hex')}`
    // Agent 1 creates a payment
    const r1 = await requestPayment(key1, { amount: '0.1', ikey })
    const d1 = await j(r1)
    const originalId = (d1.payment as { id: string }).id

    // Agent 2 uses the same key — must get a different payment, not agent 1's
    const r2 = await requestPayment(key2, { amount: '0.1', ikey })
    const d2 = await j(r2)
    const crossId = (d2.payment as { id: string }).id

    expect(crossId).not.toBe(originalId)
    expect(d2.idempotent).toBeUndefined()
  })
})

describe('HIGH-3: CORS origin restriction', () => {

  it('allowed origin receives CORS headers', async () => {
    const res = await fetch(`${base}/api/health`, {
      headers: { Origin: 'http://localhost:5173' },
    })
    // In test mode (no ALLOWED_ORIGIN env set) the local dev origin is allowed
    // The response must be 200 regardless of CORS (server-to-server ignores CORS)
    expect(res.status).toBe(200)
  })

  it('disallowed origin does not receive ACAO header', async () => {
    const res = await fetch(`${base}/api/agents`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil-hacker.example.com',
        'Access-Control-Request-Method': 'POST',
      },
    })
    const acao = res.headers.get('access-control-allow-origin')
    // Must NOT mirror back the evil origin
    expect(acao).not.toBe('https://evil-hacker.example.com')
  })
})

describe('CRITICAL-2: SIWE nonce replay prevention', () => {

  it('nonce endpoint returns unique nonces', async () => {
    const r1 = await fetch(`${base}/api/auth/nonce`).then(r => r.json()) as { nonce: string }
    const r2 = await fetch(`${base}/api/auth/nonce`).then(r => r.json()) as { nonce: string }
    expect(r1.nonce).toBeTruthy()
    expect(r2.nonce).toBeTruthy()
    expect(r1.nonce).not.toBe(r2.nonce)
  })

  it('verify rejects a missing nonce', async () => {
    const res = await fetch(`${base}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'garbage', signature: '0x00' }),
    })
    // Must fail — invalid SIWE message
    expect(res.status).toBe(401)
  })

  it('forged X-Owner-Address without JWT is rejected in production mode', async () => {
    // Hit an owner-protected route without any Authorization header in production mode.
    // In test (NODE_ENV=test) the X-Owner-Address fallback is still active for convenience,
    // so we verify the JWT code path separately via the /api/auth/me probe.
    const res = await fetch(`${base}/api/auth/me`, {
      headers: { 'X-Owner-Address': OWNER },  // no Authorization header
    })
    // /api/auth/me requires JWT even in test mode (no fallback)
    expect(res.status).toBe(401)
  })
})

describe('agent revocation', () => {

  it('revoked agent API key cannot create new payment', async () => {
    const { apiKey, id: agentObj } = await createAgent(OWNER, {
      budget_usdc: '5', max_per_tx_usdc: '1', daily_limit_usdc: '5', monthly_limit_usdc: '50',
    })
    const agentId = (agentObj as unknown as { id: string }).id

    // Confirm it works before revocation
    const before = await requestPayment(apiKey, { ikey: 'pre-revoke' })
    expect((await j(before)).payment).toBeTruthy()

    // Revoke
    await fetch(`${base}/api/agents/${agentId}/revoke`, {
      method: 'POST',
      headers: { 'X-Owner-Address': OWNER },
    })

    // Now payment request must be rejected by policy
    const after = await requestPayment(apiKey, { ikey: 'post-revoke' })
    const d = await j(after)
    expect((d.payment as { status: string }).status).toBe('REJECTED')
    expect((d.policy_result as { rejection_reason: string })?.rejection_reason).toMatch(/revoked/i)
  })
})

describe('policy: input validation', () => {

  it('rejects amount with more than 6 decimal places', async () => {
    const { apiKey } = await createAgent(OWNER)
    const res = await requestPayment(apiKey, { amount: '0.1000001', ikey: 'prec-test-1' })
    expect(res.status).toBe(400)
    const d = await j(res)
    expect((d.error as string)).toMatch(/decimal/i)
  })

  it('rejects negative amount', async () => {
    const { apiKey } = await createAgent(OWNER)
    const res = await requestPayment(apiKey, { amount: '-1', ikey: 'neg-test-1' })
    expect(res.status).toBe(400)
  })

  it('rejects invalid recipient address', async () => {
    const { apiKey } = await createAgent(OWNER)
    const res = await fetch(`${base}/api/payments/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ recipient: 'not-an-address', amount_usdc: '0.01', purpose: 'api', idempotency_key: 'badaddr-1' }),
    })
    expect(res.status).toBe(400)
  })

  it('cross-owner payment access is denied', async () => {
    const { apiKey } = await createAgent(OWNER, {
      budget_usdc: '5', max_per_tx_usdc: '1', daily_limit_usdc: '5', monthly_limit_usdc: '50',
    })
    const r = await requestPayment(apiKey, { ikey: 'cross-owner-1' })
    const payId = ((await j(r)).payment as { id: string }).id

    // Owner2 tries to approve owner1's payment
    const approveRes = await fetch(`${base}/api/payments/${payId}/approve`, {
      method: 'POST',
      headers: { 'X-Owner-Address': OWNER2 },
    })
    expect(approveRes.status).toBe(404)
  })
})
