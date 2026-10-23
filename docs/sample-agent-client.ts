/**
 * AgentPay Sample Client — Sprint 4 demo.
 *
 * This script demonstrates:
 *   1. A permitted payment that executes successfully.
 *   2. A rejected payment (exceeds per-tx limit).
 *   3. A revoked agent that cannot make new payments.
 *
 * Run against a local server:
 *   bun run docs/sample-agent-client.ts
 *
 * Environment variables:
 *   AGENTPAY_BASE_URL  — server base (default: http://localhost:3001)
 *   AGENTPAY_API_KEY   — agent API key (apk_...)
 *   AGENTPAY_AGENT_ID  — agent UUID (for revocation demo)
 *   AGENTPAY_JWT       — owner JWT (for dashboard operations; see /api/auth/nonce + /verify)
 */

const BASE    = process.env.AGENTPAY_BASE_URL ?? 'http://localhost:3001'
const API_KEY = process.env.AGENTPAY_API_KEY  ?? ''
const JWT     = process.env.AGENTPAY_JWT       ?? ''

if (!API_KEY) {
  console.error('Set AGENTPAY_API_KEY to your agent API key.')
  process.exit(1)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function agentPost(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function ownerPost(path: string, body: unknown = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${JWT}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

function ikey() { return `demo-${Date.now()}-${Math.random().toString(36).slice(2)}` }

// ─── Demo flows ───────────────────────────────────────────────────────────────

async function demoPermittedPayment() {
  console.log('\n─── Demo 1: Permitted payment ───')
  const { status, body } = await agentPost('/api/payments/request', {
    recipient:       '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    amount_usdc:     '0.05',
    purpose:         'api',
    idempotency_key: ikey(),
  })
  console.log(`  request status: ${status}`)
  const pay = body.payment as { id: string; status: string } | undefined
  const pr  = body.policy_result as { approved: boolean; rejection_reason: string | null } | undefined
  console.log(`  payment status: ${pay?.status}`)
  console.log(`  policy: approved=${pr?.approved} reason=${pr?.rejection_reason ?? 'none'}`)

  if (pay?.status === 'AUTHORIZED') {
    console.log(`  payment id: ${pay.id}`)

    // Attempt autonomous execution (requires DCW to be configured)
    const execRes = await agentPost(`/api/payments/${pay.id}/execute`, {})
    console.log(`  execute status: ${execRes.status}`)
    const eb = execRes.body
    console.log(`  payment final status: ${(eb as { status?: string }).status ?? 'unknown'}`)
    if ((eb as { tx_hash?: string }).tx_hash) {
      console.log(`  tx_hash:      ${(eb as { tx_hash: string }).tx_hash}`)
      console.log(`  explorer_url: ${(eb as { explorer_url: string }).explorer_url}`)
    } else if ((eb as { error?: string }).error) {
      console.log(`  note: ${(eb as { error: string }).error}`)
    }
  }
}

async function demoRejectedPayment() {
  console.log('\n─── Demo 2: Rejected payment (amount too large) ───')
  const { status, body } = await agentPost('/api/payments/request', {
    recipient:       '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    amount_usdc:     '9999',      // will exceed per-tx limit
    purpose:         'api',
    idempotency_key: ikey(),
  })
  console.log(`  request status: ${status}`)
  const pay = body.payment as { status: string } | undefined
  const pr  = body.policy_result as { approved: boolean; rejection_reason: string | null } | undefined
  console.log(`  payment status: ${pay?.status}`)
  console.log(`  rejection reason: ${pr?.rejection_reason ?? 'none'}`)
  if (pay?.status !== 'REJECTED') {
    console.warn('  WARNING: expected REJECTED but got', pay?.status)
  } else {
    console.log('  ✓ Payment correctly rejected')
  }
}

async function demoRevocation() {
  const agentId = process.env.AGENTPAY_AGENT_ID
  if (!agentId || !JWT) {
    console.log('\n─── Demo 3: Revocation (skipped — set AGENTPAY_AGENT_ID + AGENTPAY_JWT) ───')
    return
  }
  console.log('\n─── Demo 3: Revocation ───')

  // Revoke the agent
  const rv = await ownerPost(`/api/agents/${agentId}/revoke`)
  console.log(`  revoke status: ${rv.status}`)

  // Try to use the revoked agent's API key
  const { body } = await agentPost('/api/payments/request', {
    recipient:       '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    amount_usdc:     '0.01',
    purpose:         'api',
    idempotency_key: ikey(),
  })
  const pay = body.payment as { status: string } | undefined
  const pr  = body.policy_result as { rejection_reason: string | null } | undefined
  console.log(`  post-revoke payment status: ${pay?.status}`)
  console.log(`  rejection reason: ${pr?.rejection_reason ?? 'none'}`)
  if (pay?.status === 'REJECTED' && pr?.rejection_reason?.toLowerCase().includes('revoked')) {
    console.log('  ✓ Revoked agent correctly blocked')
  } else {
    console.warn('  WARNING: expected REJECTED/revoked but got', pay?.status, pr?.rejection_reason)
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

console.log(`AgentPay sample client — server: ${BASE}`)
await demoPermittedPayment()
await demoRejectedPayment()
await demoRevocation()
console.log('\nDone.')
