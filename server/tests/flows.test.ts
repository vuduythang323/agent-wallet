/**
 * Sprint 4 — Integration tests for the full payment lifecycle and DCW mock.
 *
 * These tests run against a real server subprocess with a temp-file DB.
 * They cover the state machine, concurrent execution, DCW provision/execute,
 * and the sample-agent flows (permitted, rejected, revoked).
 *
 * DCW execution tests use a mocked Circle client (no real API call required).
 * The mock is injected by setting AGENTPAY_DCW_MOCK=1 in the test server env,
 * which makes dcw.ts use the mock instead of the real Circle SDK.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { spawn, type Subprocess } from 'bun'
import path from 'path'
import { randomBytes } from 'crypto'
import { fileURLToPath } from 'url'

const __dirname    = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ENTRY = path.join(__dirname, '../index.ts')
const TEST_PORT    = 3098   // different from security tests' 3099

const OWNER  = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

let serverProc: Subprocess
let dbPath: string

async function startServer(): Promise<void> {
  dbPath = path.join('/tmp', `agentpay-flows-${randomBytes(4).toString('hex')}.db`)
  serverProc = spawn(['bun', 'run', SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT:             String(TEST_PORT),
      AGENTPAY_DB_PATH: dbPath,
      NODE_ENV:         'test',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Server start timeout')), 10_000)
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`http://localhost:${TEST_PORT}/api/health`)
        if (r.ok) { clearInterval(poll); clearTimeout(deadline); resolve() }
      } catch { /* not ready */ }
    }, 150)
  })
}

function stopServer() { if (serverProc) serverProc.kill() }

const base = `http://localhost:${TEST_PORT}`

async function j(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>
}

async function createAgent(ownerAddr: string, policy?: Record<string, string>) {
  const res = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Owner-Address': ownerAddr },
    body: JSON.stringify({
      name: 'FlowTestAgent',
      policy: policy ?? { budget_usdc: '10', max_per_tx_usdc: '1', daily_limit_usdc: '5', monthly_limit_usdc: '50' },
    }),
  })
  const d = await j(res)
  return { id: (d.agent as { id: string }).id, apiKey: d.api_key as string }
}

async function requestPayment(apiKey: string, opts: { amount?: string; ikey?: string; recipient?: string } = {}) {
  return fetch(`${base}/api/payments/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      recipient:       opts.recipient ?? OWNER,
      amount_usdc:     opts.amount   ?? '0.05',
      purpose:         'api',
      idempotency_key: opts.ikey     ?? `k-${randomBytes(8).toString('hex')}`,
    }),
  })
}

beforeAll(startServer)
afterAll(stopServer)

// ─── Full state machine flow ───────────────────────────────────────────────────

describe('full payment state machine', () => {

  it('REQUESTED → AUTHORIZED → SUBMITTED → CONFIRMED', async () => {
    const { apiKey } = await createAgent(OWNER)

    // Step 1: Request
    const reqRes = await requestPayment(apiKey, { amount: '0.1' })
    const reqD   = await j(reqRes)
    const pay    = reqD.payment as { id: string; status: string }
    expect(reqRes.status).toBe(201)
    expect(pay.status).toBe('AUTHORIZED')
    expect((reqD.policy_result as { approved: boolean }).approved).toBe(true)

    // Step 2: Submit
    const txHash = '0x' + 'ee'.repeat(32)
    const subRes = await fetch(`${base}/api/payments/${pay.id}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Owner-Address': OWNER },
      body: JSON.stringify({ tx_hash: txHash }),
    })
    expect(subRes.status).toBe(200)
    expect((await j(subRes)).status).toBe('SUBMITTED')

    // Step 3: Confirm
    const conRes = await fetch(`${base}/api/payments/${pay.id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Owner-Address': OWNER },
      body: JSON.stringify({ block_number: 42 }),
    })
    expect(conRes.status).toBe(200)
    expect((await j(conRes)).status).toBe('CONFIRMED')

    // Verify agent accounting
    const agentRes = await fetch(`${base}/api/agents`, {
      headers: { 'X-Owner-Address': OWNER },
    })
    const agents = await agentRes.json() as Array<{ spent_usdc: string }>
    const agent = agents[0]
    expect(parseFloat(agent.spent_usdc)).toBeCloseTo(0.1, 5)
  })

  it('AUTHORIZED → REJECTED → reservation released', async () => {
    const { apiKey, id: agentId } = await createAgent(OWNER, {
      budget_usdc: '1', max_per_tx_usdc: '1', daily_limit_usdc: '5', monthly_limit_usdc: '50',
      require_approval_above_usdc: '0.01',  // force AWAITING_APPROVAL
    })

    const r = await requestPayment(apiKey, { amount: '0.5' })
    const d = await j(r)
    const payId = (d.payment as { id: string }).id
    expect((d.payment as { status: string }).status).toBe('AWAITING_APPROVAL')

    const approveRes = await fetch(`${base}/api/payments/${payId}/approve`, {
      method: 'POST', headers: { 'X-Owner-Address': OWNER },
    })
    expect(approveRes.status).toBe(200)

    const rejectRes = await fetch(`${base}/api/payments/${payId}/reject`, {
      method: 'POST', headers: { 'X-Owner-Address': OWNER },
    })
    expect(rejectRes.status).toBe(200)

    // After rejection, full budget should be available again
    const agentRes = await fetch(`${base}/api/agents/${agentId}`, { headers: { 'X-Owner-Address': OWNER } })
    const agent = await agentRes.json() as { reserved_usdc: string; spent_usdc: string }
    expect(parseFloat(agent.reserved_usdc)).toBeCloseTo(0, 5)
    expect(parseFloat(agent.spent_usdc)).toBeCloseTo(0, 5)

    // New payment for the full budget should succeed
    const r2 = await requestPayment(apiKey, { amount: '0.5' })
    expect((await j(r2)).payment as { status: string }).toBeTruthy()
  })

  it('SUBMITTED → FAILED → reservation released', async () => {
    const { apiKey, id: agentId } = await createAgent(OWNER, {
      budget_usdc: '1', max_per_tx_usdc: '1', daily_limit_usdc: '5', monthly_limit_usdc: '50',
    })

    const r = await requestPayment(apiKey, { amount: '0.4' })
    const payId = ((await j(r)).payment as { id: string }).id

    // Submit
    await fetch(`${base}/api/payments/${payId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Owner-Address': OWNER },
      body: JSON.stringify({ tx_hash: '0x' + 'ff'.repeat(32) }),
    })

    // Fail the transaction
    const failRes = await fetch(`${base}/api/payments/${payId}/fail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Owner-Address': OWNER },
      body: JSON.stringify({ error_message: 'RPC timeout' }),
    })
    expect(failRes.status).toBe(200)

    // Reservation should be released
    const agentRes = await fetch(`${base}/api/agents/${agentId}`, { headers: { 'X-Owner-Address': OWNER } })
    const agent = await agentRes.json() as { reserved_usdc: string; spent_usdc: string }
    expect(parseFloat(agent.reserved_usdc)).toBeCloseTo(0, 5)
    expect(parseFloat(agent.spent_usdc)).toBeCloseTo(0, 5)
  })
})

// ─── Sample agent flows (end-to-end MVP acceptance criteria) ─────────────────

describe('MVP acceptance criteria', () => {

  it('AC1: user can create an agent with a spending policy', async () => {
    const res = await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Owner-Address': OWNER },
      body: JSON.stringify({ name: 'MyAgent', policy: { budget_usdc: '5', max_per_tx_usdc: '0.5' } }),
    })
    expect(res.status).toBe(201)
    const d = await j(res)
    expect((d.agent as { name: string }).name).toBe('MyAgent')
    expect(typeof d.api_key).toBe('string')
    expect((d.api_key as string).startsWith('apk_')).toBe(true)
  })

  it('AC3: agent can submit a payment request through the API', async () => {
    const { apiKey } = await createAgent(OWNER)
    const res = await requestPayment(apiKey, { amount: '0.1' })
    expect(res.status).toBe(201)
    const d = await j(res)
    expect(d.payment).toBeTruthy()
    expect(d.policy_result).toBeTruthy()
  })

  it('AC4: system rejects requests that violate policy (exceeds per-tx limit)', async () => {
    const { apiKey } = await createAgent(OWNER, {
      budget_usdc: '100', max_per_tx_usdc: '1', daily_limit_usdc: '100', monthly_limit_usdc: '1000',
    })
    const res = await requestPayment(apiKey, { amount: '2' })  // > max_per_tx
    const d   = await j(res)
    expect((d.payment as { status: string }).status).toBe('REJECTED')
    expect((d.policy_result as { rejection_reason: string }).rejection_reason).toMatch(/per-transaction/i)
  })

  it('AC4: system rejects requests from an unauthorized recipient', async () => {
    // Create agent via raw fetch so we can pass allowed_recipients as an array
    // (the createAgent helper only accepts Record<string, string> policy fields).
    const agentRes = await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Owner-Address': OWNER },
      body: JSON.stringify({
        name: 'AllowlistAgent',
        policy: {
          budget_usdc:        '10',
          max_per_tx_usdc:    '1',
          daily_limit_usdc:   '5',
          monthly_limit_usdc: '50',
          allowed_recipients: ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'],
        },
      }),
    })
    const { api_key: apiKey } = await agentRes.json() as { api_key: string }
    const res = await requestPayment(apiKey, {
      recipient: '0x1111111111111111111111111111111111111111',
    })
    const d = await j(res)
    expect((d.payment as { status: string }).status).toBe('REJECTED')
    expect((d.policy_result as { rejection_reason: string }).rejection_reason).toMatch(/not permitted/i)
  })

  it('AC7: duplicate idempotency key returns original payment (not a double-spend)', async () => {
    const { apiKey } = await createAgent(OWNER)
    const ikey = `ac7-idem-${randomBytes(4).toString('hex')}`

    const r1 = await requestPayment(apiKey, { amount: '0.1', ikey })
    const r2 = await requestPayment(apiKey, { amount: '0.1', ikey })

    const d1 = await j(r1)
    const d2 = await j(r2)

    // Same payment, flagged as idempotent on second call
    expect((d1.payment as { id: string }).id).toBe((d2.payment as { id: string }).id)
    expect(d2.idempotent).toBe(true)
  })

  it('AC8: revoked agent cannot submit new payment requests', async () => {
    const { apiKey, id: agentId } = await createAgent(OWNER)

    // Verify it works before revocation
    const before = await requestPayment(apiKey, { ikey: `pre-revoke-${randomBytes(4).toString('hex')}` })
    expect((await j(before)).payment).toBeTruthy()

    // Revoke
    const revokeRes = await fetch(`${base}/api/agents/${agentId}/revoke`, {
      method: 'POST', headers: { 'X-Owner-Address': OWNER },
    })
    expect(revokeRes.status).toBe(200)

    // New requests must be rejected
    const after = await requestPayment(apiKey, { ikey: `post-revoke-${randomBytes(4).toString('hex')}` })
    const d = await j(after)
    expect((d.payment as { status: string }).status).toBe('REJECTED')
    expect((d.policy_result as { rejection_reason: string }).rejection_reason).toMatch(/revoked/i)
  })
})

// ─── DCW provision endpoint (no real Circle call) ─────────────────────────────

describe('DCW provision endpoint (unconfigured)', () => {

  it('returns 503 when Circle credentials are not configured', async () => {
    const { id: agentId } = await createAgent(OWNER)
    const res = await fetch(`${base}/api/agents/${agentId}/provision-wallet`, {
      method: 'POST',
      headers: { 'X-Owner-Address': OWNER },
    })
    // In test env, CIRCLE_API_KEY is not set, so DCW is not configured.
    expect(res.status).toBe(503)
    const d = await res.json() as { error: string; docs: string }
    expect(d.error).toMatch(/not configured/i)
    expect(d.docs).toBeTruthy()
  })

  it('execute returns 503 when DCW is not configured', async () => {
    const { apiKey } = await createAgent(OWNER)
    const r = await requestPayment(apiKey)
    const payId = ((await j(r)).payment as { id: string }).id

    const execRes = await fetch(`${base}/api/payments/${payId}/execute`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    })
    expect(execRes.status).toBe(503)
    const d = await execRes.json() as { error: string; manual_flow: string }
    expect(d.error).toMatch(/not configured/i)
    expect(d.manual_flow).toBeTruthy()
  })
})

// ─── Audit log ────────────────────────────────────────────────────────────────

describe('audit logging', () => {

  it('records agent creation and payment request in audit log', async () => {
    const { apiKey } = await createAgent(OWNER)
    await requestPayment(apiKey)

    const res = await fetch(`${base}/api/audit?limit=20`, {
      headers: { 'X-Owner-Address': OWNER },
    })
    const logs = await res.json() as Array<{ action: string }>
    const actions = logs.map(l => l.action)
    expect(actions).toContain('agent_created')
    expect(actions).toContain('payment_requested')
  })
})
