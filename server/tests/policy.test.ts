/**
 * Sprint 4 — Unit tests for the spending policy engine.
 *
 * These tests run entirely in-process (no HTTP) and cover every rule
 * in evaluatePolicy. They are fast (<10ms each) and deterministic.
 */
import { describe, it, expect } from 'bun:test'
import { evaluatePolicy, type AgentRow } from '../policy.ts'

// ─── Fixture builder ──────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id:                         'test-agent-id',
    owner_address:              '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    status:                     'active',
    budget_usdc:                '10',
    spent_usdc:                 '0',
    reserved_usdc:              '0',
    max_per_tx_usdc:            '1',
    daily_limit_usdc:           '5',
    monthly_limit_usdc:         '50',
    daily_spent_usdc:           '0',
    monthly_spent_usdc:         '0',
    // Set reset windows far in the future so the counters are always active.
    daily_reset_at:             new Date(Date.now() + 86400_000).toISOString(),
    monthly_reset_at:           new Date(Date.now() + 30 * 86400_000).toISOString(),
    allowed_recipients:         '[]',
    allowed_purposes:           '[]',
    require_approval_above_usdc: '999999',
    ...overrides,
  }
}

const RECIPIENT = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'

// ─── Rule 1: agent must be active ─────────────────────────────────────────────

describe('policy rule: agent_active', () => {
  it('allows active agents', () => {
    const r = evaluatePolicy(makeAgent(), '0.1', RECIPIENT, 'api')
    expect(r.approved).toBe(true)
    expect(r.checks.find(c => c.rule === 'agent_active')?.passed).toBe(true)
  })

  it('rejects paused agents', () => {
    const r = evaluatePolicy(makeAgent({ status: 'paused' }), '0.1', RECIPIENT, 'api')
    expect(r.approved).toBe(false)
    expect(r.rejection_reason).toMatch(/paused/i)
  })

  it('rejects revoked agents', () => {
    const r = evaluatePolicy(makeAgent({ status: 'revoked' }), '0.1', RECIPIENT, 'api')
    expect(r.approved).toBe(false)
    expect(r.rejection_reason).toMatch(/revoked/i)
  })
})

// ─── Rule 2: positive amount ──────────────────────────────────────────────────

describe('policy rule: positive_amount', () => {
  it('rejects zero amount', () => {
    const r = evaluatePolicy(makeAgent(), '0', RECIPIENT, 'api')
    expect(r.approved).toBe(false)
  })

  it('rejects negative amount', () => {
    const r = evaluatePolicy(makeAgent(), '-1', RECIPIENT, 'api')
    expect(r.approved).toBe(false)
  })

  it('accepts small positive amount', () => {
    const r = evaluatePolicy(makeAgent(), '0.01', RECIPIENT, 'api')
    expect(r.approved).toBe(true)
  })
})

// ─── Rule 3: per-transaction limit ────────────────────────────────────────────

describe('policy rule: per_tx_limit', () => {
  it('allows amount at the limit', () => {
    const r = evaluatePolicy(makeAgent({ max_per_tx_usdc: '1' }), '1', RECIPIENT, 'api')
    expect(r.checks.find(c => c.rule === 'per_tx_limit')?.passed).toBe(true)
  })

  it('rejects amount above the limit', () => {
    const r = evaluatePolicy(makeAgent({ max_per_tx_usdc: '1' }), '1.01', RECIPIENT, 'api')
    expect(r.approved).toBe(false)
    expect(r.rejection_reason).toMatch(/per-transaction/i)
  })

  it('includes the limit value in the detail', () => {
    const r = evaluatePolicy(makeAgent({ max_per_tx_usdc: '0.5' }), '0.6', RECIPIENT, 'api')
    const check = r.checks.find(c => c.rule === 'per_tx_limit')
    expect(check?.detail).toContain('0.5')
  })
})

// ─── Rule 4: remaining budget (CRITICAL-1 fix) ────────────────────────────────

describe('policy rule: remaining_budget', () => {
  it('allows when amount equals remaining (spent+reserved=0)', () => {
    const r = evaluatePolicy(makeAgent({ budget_usdc: '1', spent_usdc: '0', reserved_usdc: '0', max_per_tx_usdc: '1' }), '1', RECIPIENT, 'api')
    expect(r.checks.find(c => c.rule === 'remaining_budget')?.passed).toBe(true)
  })

  it('rejects when spent alone exhausts budget', () => {
    const r = evaluatePolicy(makeAgent({ budget_usdc: '1', spent_usdc: '1', reserved_usdc: '0', max_per_tx_usdc: '1' }), '0.01', RECIPIENT, 'api')
    expect(r.approved).toBe(false)
    expect(r.rejection_reason).toMatch(/budget/i)
  })

  it('CRITICAL-1: rejects when reserved alone exhausts budget', () => {
    // This is the core of the concurrent overspend fix.
    // spent=0 but reserved=1.00 means no budget remains for new requests.
    const r = evaluatePolicy(makeAgent({ budget_usdc: '1', spent_usdc: '0', reserved_usdc: '1', max_per_tx_usdc: '1' }), '0.01', RECIPIENT, 'api')
    expect(r.approved).toBe(false)
    expect(r.rejection_reason).toMatch(/budget/i)
  })

  it('CRITICAL-1: rejects when spent+reserved combined exhausts budget', () => {
    // spent=0.60 + reserved=0.40 = 1.00 → zero remaining
    const r = evaluatePolicy(makeAgent({ budget_usdc: '1', spent_usdc: '0.6', reserved_usdc: '0.4', max_per_tx_usdc: '1' }), '0.01', RECIPIENT, 'api')
    expect(r.approved).toBe(false)
  })

  it('allows exactly the remaining budget (spent+reserved partial)', () => {
    // spent=0.30 + reserved=0.20 = 0.50 → 0.50 remaining
    const r = evaluatePolicy(makeAgent({ budget_usdc: '1', spent_usdc: '0.3', reserved_usdc: '0.2', max_per_tx_usdc: '1' }), '0.5', RECIPIENT, 'api')
    expect(r.checks.find(c => c.rule === 'remaining_budget')?.passed).toBe(true)
  })

  it('includes spent and reserved values in the detail string', () => {
    const r = evaluatePolicy(makeAgent({ budget_usdc: '1', spent_usdc: '0.3', reserved_usdc: '0.2', max_per_tx_usdc: '1' }), '0.6', RECIPIENT, 'api')
    const check = r.checks.find(c => c.rule === 'remaining_budget')
    expect(check?.detail).toContain('0.3')  // spent
    expect(check?.detail).toContain('0.2')  // reserved
  })
})

// ─── Rule 5: daily limit ──────────────────────────────────────────────────────

describe('policy rule: daily_limit', () => {
  it('allows when daily spent + amount <= limit', () => {
    const r = evaluatePolicy(makeAgent({ daily_limit_usdc: '5', daily_spent_usdc: '4' }), '1', RECIPIENT, 'api')
    expect(r.checks.find(c => c.rule === 'daily_limit')?.passed).toBe(true)
  })

  it('rejects when daily spent + amount > limit', () => {
    const r = evaluatePolicy(makeAgent({ daily_limit_usdc: '5', daily_spent_usdc: '4.5' }), '1', RECIPIENT, 'api')
    expect(r.approved).toBe(false)
    expect(r.rejection_reason).toMatch(/daily/i)
  })

  it('treats expired daily window as zero spent', () => {
    // daily_reset_at in the PAST → window has elapsed → daily_spent_usdc reset to 0
    const r = evaluatePolicy(makeAgent({
      daily_limit_usdc:  '5',
      daily_spent_usdc:  '4.9',    // would exceed limit if active
      daily_reset_at:    new Date(Date.now() - 1000).toISOString(),  // past
    }), '1', RECIPIENT, 'api')
    // With effective daily spent = 0, 1 USDC should pass the daily check
    const dailyCheck = r.checks.find(c => c.rule === 'daily_limit')
    expect(dailyCheck?.passed).toBe(true)
  })
})

// ─── Rule 6: monthly limit ────────────────────────────────────────────────────

describe('policy rule: monthly_limit', () => {
  it('rejects when monthly spent + amount > limit', () => {
    const r = evaluatePolicy(makeAgent({ monthly_limit_usdc: '10', monthly_spent_usdc: '9.5', max_per_tx_usdc: '1', budget_usdc: '100' }), '1', RECIPIENT, 'api')
    expect(r.approved).toBe(false)
    expect(r.rejection_reason).toMatch(/monthly/i)
  })

  it('treats expired monthly window as zero spent', () => {
    const r = evaluatePolicy(makeAgent({
      monthly_limit_usdc:  '10',
      monthly_spent_usdc:  '9.9',
      monthly_reset_at:    new Date(Date.now() - 1000).toISOString(),
    }), '1', RECIPIENT, 'api')
    const monthlyCheck = r.checks.find(c => c.rule === 'monthly_limit')
    expect(monthlyCheck?.passed).toBe(true)
  })
})

// ─── Rule 7: recipient allowlist ──────────────────────────────────────────────

describe('policy rule: recipient_allowlist', () => {
  it('allows any recipient when allowlist is empty', () => {
    const r = evaluatePolicy(makeAgent({ allowed_recipients: '[]' }), '0.1', '0xdeadbeef00000000000000000000000000000001', 'api')
    expect(r.checks.find(c => c.rule === 'recipient_allowlist')?.passed).toBe(true)
  })

  it('allows a recipient on the allowlist (case-insensitive)', () => {
    const allowed = RECIPIENT.toUpperCase()
    const r = evaluatePolicy(makeAgent({ allowed_recipients: JSON.stringify([allowed]) }), '0.1', RECIPIENT, 'api')
    expect(r.checks.find(c => c.rule === 'recipient_allowlist')?.passed).toBe(true)
  })

  it('rejects a recipient NOT on the allowlist', () => {
    const r = evaluatePolicy(makeAgent({ allowed_recipients: JSON.stringify([RECIPIENT]) }), '0.1', '0x1111111111111111111111111111111111111111', 'api')
    expect(r.approved).toBe(false)
    expect(r.rejection_reason).toMatch(/not permitted/i)
  })
})

// ─── Rule 8: purpose allowlist ────────────────────────────────────────────────

describe('policy rule: purpose_allowlist', () => {
  it('allows any purpose when allowlist is empty', () => {
    const r = evaluatePolicy(makeAgent({ allowed_purposes: '[]' }), '0.1', RECIPIENT, 'any_purpose')
    expect(r.checks.find(c => c.rule === 'purpose_allowlist')?.passed).toBe(true)
  })

  it('allows a purpose on the allowlist', () => {
    const r = evaluatePolicy(makeAgent({ allowed_purposes: '["api","search"]' }), '0.1', RECIPIENT, 'api')
    expect(r.checks.find(c => c.rule === 'purpose_allowlist')?.passed).toBe(true)
  })

  it('rejects a purpose NOT on the allowlist', () => {
    const r = evaluatePolicy(makeAgent({ allowed_purposes: '["api"]' }), '0.1', RECIPIENT, 'trading')
    expect(r.approved).toBe(false)
    expect(r.rejection_reason).toMatch(/not permitted/i)
  })
})

// ─── Human approval threshold ─────────────────────────────────────────────────

describe('policy: human approval threshold', () => {
  it('does not require approval when below threshold', () => {
    const r = evaluatePolicy(makeAgent({ require_approval_above_usdc: '1', max_per_tx_usdc: '2', budget_usdc: '100' }), '0.99', RECIPIENT, 'api')
    expect(r.approved).toBe(true)
    expect(r.requires_human_approval).toBe(false)
  })

  it('requires approval when above threshold', () => {
    const r = evaluatePolicy(makeAgent({ require_approval_above_usdc: '0.5', max_per_tx_usdc: '2', budget_usdc: '100' }), '0.51', RECIPIENT, 'api')
    expect(r.approved).toBe(true)
    expect(r.requires_human_approval).toBe(true)
  })

  it('does not require approval on rejected payments', () => {
    const r = evaluatePolicy(makeAgent({ status: 'revoked', require_approval_above_usdc: '0' }), '0.1', RECIPIENT, 'api')
    expect(r.approved).toBe(false)
    expect(r.requires_human_approval).toBe(false)
  })
})

// ─── All checks present ───────────────────────────────────────────────────────

describe('policy: checks completeness', () => {
  it('always returns all 8 check rules', () => {
    const r = evaluatePolicy(makeAgent(), '0.1', RECIPIENT, 'api')
    const rules = r.checks.map(c => c.rule)
    const expected = [
      'agent_active', 'positive_amount', 'per_tx_limit', 'remaining_budget',
      'daily_limit', 'monthly_limit', 'recipient_allowlist', 'purpose_allowlist',
    ]
    for (const rule of expected) {
      expect(rules).toContain(rule)
    }
  })
})
