/**
 * Payments router — security-hardened version.
 *
 * CRITICAL-1: Atomic budget reservation prevents concurrent overspending.
 *   - On AUTHORIZED: atomically reserve amount in agents.reserved_usdc.
 *   - On CONFIRMED:  move reservation → spent (still atomic, single transaction).
 *   - On terminal failure/cancel: release reservation atomically.
 *   - Policy check reads (spent + reserved) so concurrent requests see each other's reservations.
 *
 * CRITICAL-3: Confirm ignores caller-supplied amount_usdc entirely.
 *   - Authoritative amount is always read from the payments row in the DB.
 *   - block_number is still accepted but only used for informational storage.
 *
 * HIGH-2: Idempotency key scoped to (agent_id, idempotency_key).
 *   - A different agent cannot retrieve another agent's payment via key collision.
 */
import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import db from '../db.ts'
import { requireOwnerJwt, requireAgentApiKey } from '../auth.ts'
import { evaluatePolicy } from '../policy.ts'
import { auditLog } from '../audit.ts'
import type { AgentRow } from '../policy.ts'
import {
  executeAgentPayment,
  pollCircleTransaction,
  CIRCLE_TERMINAL_STATES,
  isDcwConfigured,
  ARC_TESTNET_EXPLORER,
} from '../dcw.ts'

const router = Router()

// ─── Helper: release reservation atomically ──────────────────────────────────
function releaseReservation(paymentId: string, agentId: string, amountUsdc: string) {
  db.transaction(() => {
    db.run(`
      UPDATE agents SET
        reserved_usdc = CAST(MAX(0, CAST(reserved_usdc AS REAL) - $amt) AS TEXT),
        updated_at    = datetime('now')
      WHERE id = $id
    `, { $amt: parseFloat(amountUsdc), $id: agentId })
  })()
}

// ─── POST /api/payments/request (agent API-key authenticated) ─────────────────
router.post('/request', requireAgentApiKey, (req, res) => {
  // agent row is attached by requireAgentApiKey middleware
  const agent = (req as Record<string, unknown>).agent as AgentRow & { owner_address: string }
  const { recipient, amount_usdc, purpose, idempotency_key } = req.body as {
    recipient?: string
    amount_usdc?: string
    purpose?: string
    idempotency_key?: string
  }

  // ── Input validation ────────────────────────────────────────────────────────
  if (!recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    res.status(400).json({ error: 'recipient must be a valid EVM address' }); return
  }
  const parsedAmount = parseFloat(amount_usdc ?? '')
  if (!amount_usdc || isNaN(parsedAmount) || parsedAmount <= 0) {
    res.status(400).json({ error: 'amount_usdc must be a positive number' }); return
  }
  // Clamp precision to 6 decimal places (USDC) to prevent floating-point confusion.
  if (!/^\d+(\.\d{1,6})?$/.test(amount_usdc)) {
    res.status(400).json({ error: 'amount_usdc must have at most 6 decimal places' }); return
  }
  if (!idempotency_key || typeof idempotency_key !== 'string' || idempotency_key.length < 8 || idempotency_key.length > 128) {
    res.status(400).json({ error: 'idempotency_key is required (8–128 chars)' }); return
  }

  // ── HIGH-2: Idempotency scoped to this agent ─────────────────────────────────
  // The UNIQUE(agent_id, idempotency_key) DB constraint also enforces this at write time.
  const existing = db.query(
    'SELECT * FROM payments WHERE agent_id = ? AND idempotency_key = ?'
  ).get(agent.id, idempotency_key) as Record<string, unknown> | undefined
  if (existing) {
    // Only return this payment to the agent that owns it (already guaranteed by agent_id scope).
    res.status(200).json({ payment: existing, idempotent: true }); return
  }

  // ── CRITICAL-1: Re-read agent inside the transaction with a write lock ────────
  // SQLite serializes writes; reading agent inside the transaction that also
  // writes the reservation ensures no concurrent transaction can slip between
  // the read and the write.
  const id = uuid()
  const purposeStr = purpose ?? 'general'
  let policyResult
  let initialStatus: string

  try {
    db.transaction(() => {
      // Re-read agent with the latest reserved_usdc so concurrent requests
      // see each other's in-flight reservations before committing.
      const freshAgent = db.query('SELECT * FROM agents WHERE id = ?').get(agent.id) as AgentRow | undefined
      if (!freshAgent) throw new Error('Agent not found')

      policyResult = evaluatePolicy(freshAgent, amount_usdc, recipient, purposeStr)
      const requiresApproval = policyResult.approved && policyResult.requires_human_approval
      initialStatus = !policyResult.approved ? 'REJECTED' : requiresApproval ? 'AWAITING_APPROVAL' : 'AUTHORIZED'

      // Insert payment row first (UNIQUE constraint catches concurrent duplicate keys).
      db.run(`
        INSERT INTO payments
          (id, agent_id, owner_address, recipient, amount_usdc, purpose, idempotency_key, status, policy_result)
        VALUES
          ($id, $agentId, $owner, $recipient, $amount, $purpose, $ikey, $status, $policy)
      `, {
        $id: id, $agentId: agent.id, $owner: agent.owner_address,
        $recipient: recipient.toLowerCase(), $amount: amount_usdc,
        $purpose: purposeStr, $ikey: idempotency_key,
        $status: initialStatus, $policy: JSON.stringify(policyResult),
      })

      // CRITICAL-1: Only reserve when the payment is approved (authorized or awaiting approval).
      // Rejected payments never touch reserved_usdc.
      if (initialStatus !== 'REJECTED') {
        db.run(`
          UPDATE agents SET
            reserved_usdc = CAST(CAST(reserved_usdc AS REAL) + $amt AS TEXT),
            updated_at    = datetime('now')
          WHERE id = $id
        `, { $amt: parsedAmount, $id: agent.id })
      }

      auditLog({
        agent_id: agent.id, payment_id: id, actor: 'agent', action: 'payment_requested',
        detail: `amount=${amount_usdc} recipient=${recipient} status=${initialStatus}`,
        ip: req.ip,
      })
    })()
  } catch (err) {
    const msg = (err as Error).message ?? ''
    // SQLite UNIQUE constraint violation on (agent_id, idempotency_key) from a concurrent request.
    if (msg.includes('UNIQUE constraint failed')) {
      const raceExisting = db.query(
        'SELECT * FROM payments WHERE agent_id = ? AND idempotency_key = ?'
      ).get(agent.id, idempotency_key)
      res.status(200).json({ payment: raceExisting, idempotent: true }); return
    }
    console.error('[payments/request]', err)
    res.status(500).json({ error: 'Internal server error' }); return
  }

  const payment = db.query('SELECT * FROM payments WHERE id = ?').get(id)
  res.status(201).json({ payment, policy_result: policyResult })
})

// ─── POST /api/payments/:id/approve ──────────────────────────────────────────
router.post('/:id/approve', requireOwnerJwt, (req, res) => {
  const owner = (req as Record<string, unknown>).ownerAddress as string
  const payment = db.query(
    'SELECT * FROM payments WHERE id = ? AND owner_address = ?'
  ).get(req.params.id, owner) as Record<string, unknown> | undefined
  if (!payment) { res.status(404).json({ error: 'Payment not found' }); return }
  if (payment.status !== 'AWAITING_APPROVAL') {
    res.status(409).json({ error: `Payment is ${payment.status as string}, not AWAITING_APPROVAL` }); return
  }
  db.run(
    "UPDATE payments SET status = 'AUTHORIZED', updated_at = datetime('now') WHERE id = ?",
    [req.params.id]
  )
  auditLog({ agent_id: payment.agent_id as string, payment_id: req.params.id, actor: 'user', action: 'payment_approved', ip: req.ip })
  res.json({ success: true, status: 'AUTHORIZED' })
})

// ─── POST /api/payments/:id/reject ───────────────────────────────────────────
router.post('/:id/reject', requireOwnerJwt, (req, res) => {
  const owner = (req as Record<string, unknown>).ownerAddress as string
  const payment = db.query(
    'SELECT * FROM payments WHERE id = ? AND owner_address = ?'
  ).get(req.params.id, owner) as Record<string, unknown> | undefined
  if (!payment) { res.status(404).json({ error: 'Payment not found' }); return }
  if (!['AWAITING_APPROVAL', 'AUTHORIZED'].includes(payment.status as string)) {
    res.status(409).json({ error: `Cannot reject a payment in status ${payment.status as string}` }); return
  }

  // CRITICAL-1: Release reservation when rejecting an approved payment.
  db.transaction(() => {
    db.run(
      "UPDATE payments SET status = 'REJECTED', error_message = 'Rejected by user', updated_at = datetime('now') WHERE id = ?",
      [req.params.id]
    )
    releaseReservation(req.params.id, payment.agent_id as string, payment.amount_usdc as string)
    auditLog({ agent_id: payment.agent_id as string, payment_id: req.params.id, actor: 'user', action: 'payment_rejected', ip: req.ip })
  })()
  res.json({ success: true, status: 'REJECTED' })
})

// ─── POST /api/payments/:id/submit ───────────────────────────────────────────
router.post('/:id/submit', requireOwnerJwt, (req, res) => {
  const owner = (req as Record<string, unknown>).ownerAddress as string
  const { tx_hash } = req.body as { tx_hash?: string }
  const payment = db.query(
    'SELECT * FROM payments WHERE id = ? AND owner_address = ?'
  ).get(req.params.id, owner) as Record<string, unknown> | undefined
  if (!payment) { res.status(404).json({ error: 'Payment not found' }); return }
  if (payment.status !== 'AUTHORIZED') {
    res.status(409).json({ error: `Payment must be AUTHORIZED before submission (current: ${payment.status as string})` }); return
  }
  if (!tx_hash || !/^0x[0-9a-fA-F]{64}$/.test(tx_hash)) {
    res.status(400).json({ error: 'tx_hash must be a valid 32-byte transaction hash' }); return
  }
  const dup = db.query('SELECT id FROM payments WHERE tx_hash = ? AND id != ?').get(tx_hash, req.params.id)
  if (dup) { res.status(409).json({ error: 'Duplicate transaction hash already recorded' }); return }

  db.run(
    "UPDATE payments SET status = 'SUBMITTED', tx_hash = $hash, updated_at = datetime('now') WHERE id = $id",
    { $hash: tx_hash, $id: req.params.id }
  )
  auditLog({ agent_id: payment.agent_id as string, payment_id: req.params.id, actor: 'user', action: 'payment_submitted', detail: `tx_hash=${tx_hash}`, ip: req.ip })
  res.json({ success: true, status: 'SUBMITTED' })
})

// ─── POST /api/payments/:id/confirm ──────────────────────────────────────────
/**
 * CRITICAL-3 FIX: amount_usdc from the request body is IGNORED.
 * The authoritative amount is always the value stored on the payment row,
 * which was validated and policy-checked at request time and never changes.
 *
 * This closes the audit-reported exploit where a caller sent amount_usdc=9999
 * and corrupted the agent's spent_usdc counter.
 */
router.post('/:id/confirm', requireOwnerJwt, (req, res) => {
  const owner = (req as Record<string, unknown>).ownerAddress as string
  // block_number is informational only; amount_usdc from body is intentionally ignored.
  const { block_number } = req.body as { block_number?: number }
  const payment = db.query(
    'SELECT * FROM payments WHERE id = ? AND owner_address = ?'
  ).get(req.params.id, owner) as Record<string, unknown> | undefined
  if (!payment) { res.status(404).json({ error: 'Payment not found' }); return }
  if (payment.status !== 'SUBMITTED') {
    res.status(409).json({ error: `Payment must be SUBMITTED (current: ${payment.status as string})` }); return
  }

  // Authoritative amount from the DB — never from the caller.
  const trustedAmount = parseFloat(payment.amount_usdc as string)
  if (isNaN(trustedAmount) || trustedAmount <= 0) {
    res.status(500).json({ error: 'Stored payment amount is invalid — cannot confirm' }); return
  }

  db.transaction(() => {
    // Mark confirmed.
    db.run(
      "UPDATE payments SET status = 'CONFIRMED', block_number = $block, updated_at = datetime('now') WHERE id = $id",
      { $block: block_number ?? null, $id: req.params.id }
    )
    // CRITICAL-1 + CRITICAL-3: move reservation → spent using the trusted DB amount.
    // This is atomic: no other transaction can observe a state where neither
    // reserved_usdc nor spent_usdc contains this amount.
    db.run(`
      UPDATE agents SET
        spent_usdc         = CAST(CAST(spent_usdc AS REAL) + $amt AS TEXT),
        reserved_usdc      = CAST(MAX(0, CAST(reserved_usdc AS REAL) - $amt) AS TEXT),
        daily_spent_usdc   = CAST(CAST(daily_spent_usdc AS REAL) + $amt AS TEXT),
        monthly_spent_usdc = CAST(CAST(monthly_spent_usdc AS REAL) + $amt AS TEXT),
        updated_at         = datetime('now')
      WHERE id = $id
    `, { $amt: trustedAmount, $id: payment.agent_id })
    auditLog({
      agent_id: payment.agent_id as string, payment_id: req.params.id,
      actor: 'system', action: 'payment_confirmed',
      detail: `block=${block_number ?? ''} amount=${trustedAmount}`,
      ip: req.ip,
    })
  })()
  res.json({ success: true, status: 'CONFIRMED' })
})

// ─── POST /api/payments/:id/fail ─────────────────────────────────────────────
router.post('/:id/fail', requireOwnerJwt, (req, res) => {
  const owner = (req as Record<string, unknown>).ownerAddress as string
  const { error_message } = req.body as { error_message?: string }
  const payment = db.query(
    'SELECT * FROM payments WHERE id = ? AND owner_address = ?'
  ).get(req.params.id, owner) as Record<string, unknown> | undefined
  if (!payment) { res.status(404).json({ error: 'Payment not found' }); return }

  const priorStatus = payment.status as string
  const releaseable = ['AWAITING_APPROVAL', 'AUTHORIZED', 'SUBMITTED'].includes(priorStatus)

  db.transaction(() => {
    db.run(
      "UPDATE payments SET status = 'FAILED', error_message = $msg, updated_at = datetime('now') WHERE id = $id",
      { $msg: error_message ?? 'Transaction failed', $id: req.params.id }
    )
    // CRITICAL-1: Release reservation on any failure of a previously approved payment.
    if (releaseable) {
      releaseReservation(req.params.id, payment.agent_id as string, payment.amount_usdc as string)
    }
    auditLog({ agent_id: payment.agent_id as string, payment_id: req.params.id, actor: 'system', action: 'payment_failed', detail: error_message ?? '', ip: req.ip })
  })()
  res.json({ success: true, status: 'FAILED' })
})

// ─── POST /api/payments/:id/execute ──────────────────────────────────────────
/**
 * Sprint 3: Autonomous execution via Circle DCW.
 *
 * This endpoint is called by the AGENT (not the user dashboard) to execute a
 * payment that has been authorized by the policy engine. It:
 *   1. Verifies the payment is AUTHORIZED and belongs to the agent's API key.
 *   2. Checks the agent has a provisioned DCW wallet.
 *   3. Submits the USDC transfer via Circle createTransaction.
 *   4. Polls until a terminal state is reached (Arc: instant finality).
 *   5. Updates payment to CONFIRMED or FAILED atomically.
 *
 * Security: uses the payment's DB-stored amount (trusted), never the caller's.
 * Idempotency: Circle's idempotency key prevents duplicate on-chain transfers.
 *
 * DOCUMENTED LIMITATION: Spending limits are enforced by the policy engine
 * (backend-only), not on-chain. A compromised server could bypass them.
 * The practical ceiling is the wallet's actual USDC balance.
 */
router.post('/:id/execute', requireAgentApiKey, async (req, res) => {
  const agent = (req as Record<string, unknown>).agent as AgentRow & {
    owner_address: string
    circle_wallet_id?: string
    circle_wallet_address?: string
  }

  const payment = db.query(
    'SELECT * FROM payments WHERE id = ? AND agent_id = ?'
  ).get(req.params.id, agent.id) as Record<string, unknown> | undefined

  if (!payment) { res.status(404).json({ error: 'Payment not found for this agent' }); return }
  if (payment.status !== 'AUTHORIZED') {
    res.status(409).json({ error: `Payment must be AUTHORIZED before execution (current: ${payment.status as string})` }); return
  }
  if (!isDcwConfigured()) {
    res.status(503).json({
      error: 'Autonomous execution not configured. Provision CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET.',
      manual_flow: 'Use POST /submit then POST /confirm for manual execution.',
    }); return
  }
  if (!agent.circle_wallet_id) {
    res.status(422).json({
      error: 'This agent has no provisioned wallet. Call POST /api/agents/:id/provision-wallet first.',
    }); return
  }

  // Trusted amount from DB — caller cannot override this.
  const amountUsdc = payment.amount_usdc as string
  const recipient  = payment.recipient  as string

  // Mark as SUBMITTED with circle_tx_id placeholder while we wait for Circle.
  const execResult = await executeAgentPayment({
    walletId:         agent.circle_wallet_id,
    recipientAddress: recipient,
    amountUsdc,
    paymentId:        req.params.id,
  })

  if (execResult.status === 'failed') {
    db.transaction(() => {
      db.run(
        "UPDATE payments SET status = 'FAILED', error_message = $msg, updated_at = datetime('now') WHERE id = $id",
        { $msg: execResult.error ?? 'DCW execution failed', $id: req.params.id }
      )
      releaseReservation(req.params.id, agent.id, amountUsdc)
      auditLog({ agent_id: agent.id, payment_id: req.params.id, actor: 'system', action: 'payment_exec_failed', detail: execResult.error ?? '', ip: req.ip })
    })()
    res.status(502).json({ error: execResult.error ?? 'Transaction submission failed' }); return
  }

  // Store the Circle tx ID and mark SUBMITTED.
  db.run(
    "UPDATE payments SET status = 'SUBMITTED', circle_tx_id = $cid, updated_at = datetime('now') WHERE id = $id",
    { $cid: execResult.circleTxId, $id: req.params.id }
  )
  auditLog({ agent_id: agent.id, payment_id: req.params.id, actor: 'system', action: 'payment_submitted_dcw', detail: `circle_tx_id=${execResult.circleTxId}`, ip: req.ip })

  // Poll for terminal state (Arc instant finality → fast completion).
  // We do this synchronously in the request to give the agent a definitive answer.
  // For slow chains, consider an async job + webhook instead.
  const poll = await pollCircleTransaction(execResult.circleTxId, 40, 2000)

  if (poll.state === 'COMPLETE') {
    const trustedAmount = parseFloat(amountUsdc)
    db.transaction(() => {
      db.run(
        "UPDATE payments SET status = 'CONFIRMED', tx_hash = $hash, updated_at = datetime('now') WHERE id = $id",
        { $hash: poll.txHash ?? null, $id: req.params.id }
      )
      db.run(`
        UPDATE agents SET
          spent_usdc         = CAST(CAST(spent_usdc AS REAL) + $amt AS TEXT),
          reserved_usdc      = CAST(MAX(0, CAST(reserved_usdc AS REAL) - $amt) AS TEXT),
          daily_spent_usdc   = CAST(CAST(daily_spent_usdc AS REAL) + $amt AS TEXT),
          monthly_spent_usdc = CAST(CAST(monthly_spent_usdc AS REAL) + $amt AS TEXT),
          updated_at         = datetime('now')
        WHERE id = $id
      `, { $amt: trustedAmount, $id: agent.id })
      auditLog({
        agent_id: agent.id, payment_id: req.params.id, actor: 'system', action: 'payment_confirmed_dcw',
        detail: `tx_hash=${poll.txHash ?? ''} amount=${amountUsdc}`, ip: req.ip,
      })
    })()
    res.json({
      success:     true,
      status:      'CONFIRMED',
      tx_hash:     poll.txHash,
      explorer_url: poll.txHash ? `${ARC_TESTNET_EXPLORER}/tx/${poll.txHash}` : null,
      amount_usdc: amountUsdc,
    }); return
  }

  // Terminal failure states or timeout.
  const failReason = CIRCLE_TERMINAL_STATES.has(poll.state)
    ? `Circle transaction ${poll.state}`
    : `Polling timed out (last state: ${poll.state})`

  db.transaction(() => {
    db.run(
      "UPDATE payments SET status = 'FAILED', error_message = $msg, updated_at = datetime('now') WHERE id = $id",
      { $msg: failReason, $id: req.params.id }
    )
    releaseReservation(req.params.id, agent.id, amountUsdc)
    auditLog({ agent_id: agent.id, payment_id: req.params.id, actor: 'system', action: 'payment_failed_dcw', detail: failReason, ip: req.ip })
  })()
  res.status(502).json({ success: false, status: 'FAILED', error: failReason })
})

// ─── GET /api/payments ───────────────────────────────────────────────────────
router.get('/', requireOwnerJwt, (req, res) => {
  const owner = (req as Record<string, unknown>).ownerAddress as string
  const { agent_id, status, limit = '50', offset = '0' } = req.query as Record<string, string>
  const lim = Math.min(200, Math.max(1, parseInt(limit) || 50))
  const off = Math.max(0, parseInt(offset) || 0)
  let query = 'SELECT * FROM payments WHERE owner_address = ?'
  const params: unknown[] = [owner]
  if (agent_id) { query += ' AND agent_id = ?'; params.push(agent_id) }
  if (status)   { query += ' AND status = ?'; params.push(status) }
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  params.push(lim, off)
  res.json(db.query(query).all(...params))
})

// ─── GET /api/payments/:id ───────────────────────────────────────────────────
router.get('/:id', requireOwnerJwt, (req, res) => {
  const owner = (req as Record<string, unknown>).ownerAddress as string
  const payment = db.query(
    'SELECT * FROM payments WHERE id = ? AND owner_address = ?'
  ).get(req.params.id, owner)
  if (!payment) { res.status(404).json({ error: 'Payment not found' }); return }
  res.json(payment)
})

export default router
