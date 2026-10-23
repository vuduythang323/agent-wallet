import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import db from '../db.ts'
import { generateApiKey, hashApiKey, requireOwnerJwt } from '../auth.ts'
import { auditLog } from '../audit.ts'
import {
  provisionAgentWallet,
  getAgentWalletBalance,
  isDcwConfigured,
  DcwNotConfiguredError,
  ARC_TESTNET_EXPLORER,
} from '../dcw.ts'

const router = Router()
router.use(requireOwnerJwt)

// ─── GET /api/agents ────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const owner = (req as Record<string, unknown>).ownerAddress as string
  const rows = db.query('SELECT * FROM agents WHERE owner_address = ? ORDER BY created_at DESC').all(owner)
  res.json(rows.map(parseAgent))
})

// ─── POST /api/agents ───────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const owner = (req as Record<string, unknown>).ownerAddress as string
  const { name, description, policy } = req.body as {
    name?: string
    description?: string
    policy?: Record<string, string | string[]>
  }
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    res.status(400).json({ error: 'name is required' })
    return
  }
  const p = policy ?? {}
  const id = uuid()
  const plainKey = generateApiKey()
  const keyHash = hashApiKey(plainKey)

  db.run(`
    INSERT INTO agents (
      id, owner_address, name, description, status, api_key_hash,
      budget_usdc, spent_usdc, max_per_tx_usdc,
      daily_limit_usdc, monthly_limit_usdc,
      daily_spent_usdc, monthly_spent_usdc,
      daily_reset_at, monthly_reset_at,
      allowed_recipients, allowed_purposes,
      require_approval_above_usdc
    ) VALUES (
      $id, $owner, $name, $desc, 'active', $keyHash,
      $budget, '0', $maxPerTx,
      $daily, $monthly,
      '0', '0',
      datetime('now', '+1 day'), datetime('now', '+30 days'),
      $recipients, $purposes,
      $approvalAbove
    )
  `, {
    $id: id, $owner: owner, $name: name.trim(), $desc: (description ?? '').trim(), $keyHash: keyHash,
    $budget: String(p.budget_usdc ?? '10'),
    $maxPerTx: String(p.max_per_tx_usdc ?? '1'),
    $daily: String(p.daily_limit_usdc ?? '5'),
    $monthly: String(p.monthly_limit_usdc ?? '50'),
    $recipients: JSON.stringify(p.allowed_recipients ?? []),
    $purposes: JSON.stringify(p.allowed_purposes ?? []),
    $approvalAbove: String(p.require_approval_above_usdc ?? '999999'),
  })

  auditLog({ agent_id: id, actor: 'user', action: 'agent_created', detail: `name=${name}`, ip: req.ip })

  const agent = db.query('SELECT * FROM agents WHERE id = ?').get(id)
  res.status(201).json({ agent: parseAgent(agent as Record<string, unknown>), api_key: plainKey })
})

// ─── GET /api/agents/:id ────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const owner = (req as Record<string, unknown>).ownerAddress as string
  const agent = db.query('SELECT * FROM agents WHERE id = ? AND owner_address = ?').get(req.params.id, owner)
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }
  res.json(parseAgent(agent as Record<string, unknown>))
})

// ─── PATCH /api/agents/:id/policy ──────────────────────────────────────────
router.patch('/:id/policy', (req, res) => {
  const owner = (req as Record<string, unknown>).ownerAddress as string
  const agent = db.query('SELECT * FROM agents WHERE id = ? AND owner_address = ?').get(req.params.id, owner) as Record<string, unknown> | undefined
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }
  if (agent.status === 'revoked') { res.status(403).json({ error: 'Cannot update policy of a revoked agent' }); return }

  const p = req.body as Record<string, string | string[]>
  const allowed = [
    'budget_usdc','max_per_tx_usdc','daily_limit_usdc','monthly_limit_usdc',
    'allowed_recipients','allowed_purposes','require_approval_above_usdc',
  ]
  const setClauses: string[] = []
  const params: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in p) {
      setClauses.push(`${key} = $${key}`)
      const val = p[key]
      params[`$${key}`] = Array.isArray(val) ? JSON.stringify(val) : String(val)
    }
  }
  if (setClauses.length === 0) { res.status(400).json({ error: 'No valid fields to update' }); return }
  setClauses.push("updated_at = datetime('now')")
  params.$id = req.params.id
  params.$owner = owner
  db.run(`UPDATE agents SET ${setClauses.join(', ')} WHERE id = $id AND owner_address = $owner`, params)

  auditLog({ agent_id: req.params.id, actor: 'user', action: 'policy_updated', detail: JSON.stringify(p), ip: req.ip })

  const updated = db.query('SELECT * FROM agents WHERE id = ?').get(req.params.id)
  res.json(parseAgent(updated as Record<string, unknown>))
})

// ─── POST /api/agents/:id/provision-wallet ───────────────────────────────────
/**
 * Sprint 3: Provision a Circle developer-controlled EOA wallet for an agent.
 * Requires CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET in server env.
 * Idempotent: returns existing wallet info if already provisioned.
 */
router.post('/:id/provision-wallet', async (req, res) => {
  const owner = (req as Record<string, unknown>).ownerAddress as string
  const agent = db.query('SELECT * FROM agents WHERE id = ? AND owner_address = ?')
    .get(req.params.id, owner) as Record<string, unknown> | undefined
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }
  if (agent.status === 'revoked') { res.status(403).json({ error: 'Cannot provision wallet for a revoked agent' }); return }

  // Idempotent: if already provisioned, return existing info.
  if (agent.circle_wallet_id) {
    res.json({
      already_provisioned: true,
      wallet_id:      agent.circle_wallet_id,
      wallet_address: agent.circle_wallet_address,
      explorer_url:   `${ARC_TESTNET_EXPLORER}/address/${agent.circle_wallet_address as string}`,
    }); return
  }

  if (!isDcwConfigured()) {
    res.status(503).json({
      error: 'Autonomous execution is not configured. Set CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET.',
      docs:  'See docs/sprint3-setup.md',
    }); return
  }

  try {
    const result = await provisionAgentWallet(req.params.id, agent.name as string)
    db.run(`
      UPDATE agents SET
        circle_wallet_id      = $wid,
        circle_wallet_address = $addr,
        circle_wallet_set_id  = $wsid,
        updated_at            = datetime('now')
      WHERE id = $id
    `, {
      $wid:  result.walletId,
      $addr: result.walletAddress,
      $wsid: result.walletSetId,
      $id:   req.params.id,
    })
    auditLog({
      agent_id: req.params.id, actor: 'user', action: 'wallet_provisioned',
      detail: `wallet_id=${result.walletId} address=${result.walletAddress}`,
      ip: req.ip,
    })
    res.status(201).json({
      wallet_id:      result.walletId,
      wallet_address: result.walletAddress,
      explorer_url:   `${ARC_TESTNET_EXPLORER}/address/${result.walletAddress}`,
      funding_note:   `Fund this address with USDC on Arc Testnet to enable autonomous payments. Get test USDC from the sidebar.`,
    })
  } catch (err) {
    if (err instanceof DcwNotConfiguredError) {
      res.status(503).json({ error: err.message }); return
    }
    console.error('[provision-wallet]', err)
    res.status(500).json({ error: 'Failed to provision wallet. Check server logs.' })
  }
})

// ─── GET /api/agents/:id/wallet-balance ──────────────────────────────────────
router.get('/:id/wallet-balance', async (req, res) => {
  const owner = (req as Record<string, unknown>).ownerAddress as string
  const agent = db.query('SELECT * FROM agents WHERE id = ? AND owner_address = ?')
    .get(req.params.id, owner) as Record<string, unknown> | undefined
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }
  if (!agent.circle_wallet_id) {
    res.json({ configured: false, message: 'No wallet provisioned for this agent' }); return
  }
  if (!isDcwConfigured()) {
    res.status(503).json({ error: 'DCW not configured' }); return
  }
  try {
    const balance = await getAgentWalletBalance(agent.circle_wallet_id as string)
    res.json({
      configured:     true,
      wallet_id:      agent.circle_wallet_id,
      wallet_address: agent.circle_wallet_address,
      usdc_balance:   balance?.usdc ?? '0',
      explorer_url:   `${ARC_TESTNET_EXPLORER}/address/${agent.circle_wallet_address as string}`,
    })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// ─── POST /api/agents/:id/pause ─────────────────────────────────────────────
router.post('/:id/pause',   (req, res) => setStatus(req, res, 'paused'))
router.post('/:id/resume',  (req, res) => setStatus(req, res, 'active'))
router.post('/:id/revoke',  (req, res) => setStatus(req, res, 'revoked'))

function setStatus(req: import('express').Request, res: import('express').Response, newStatus: string) {
  const owner = (req as Record<string, unknown>).ownerAddress as string
  const agent = db.query('SELECT * FROM agents WHERE id = ? AND owner_address = ?').get(req.params.id, owner) as Record<string, unknown> | undefined
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }
  if (agent.status === 'revoked' && newStatus !== 'revoked') {
    res.status(403).json({ error: 'Revoked agents cannot be reactivated' }); return
  }
  db.run("UPDATE agents SET status = $s, updated_at = datetime('now') WHERE id = $id", { $s: newStatus, $id: req.params.id })
  auditLog({ agent_id: req.params.id, actor: 'user', action: `agent_${newStatus}`, detail: '', ip: req.ip })
  res.json({ success: true, status: newStatus })
}

function parseAgent(row: Record<string, unknown>) {
  return {
    ...row,
    allowed_recipients: safeJson(row.allowed_recipients as string, []),
    allowed_purposes: safeJson(row.allowed_purposes as string, []),
  }
}

function safeJson<T>(v: string, fallback: T): T {
  try { return JSON.parse(v) as T } catch { return fallback }
}

export default router
