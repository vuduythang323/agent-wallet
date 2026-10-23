/**
 * Spending Policy Engine — evaluates every payment request against the agent's
 * configured rules. Fails closed: any exception returns approved:false.
 */
import type { PolicyResult, PolicyCheck } from '../src/types/index.ts'

export interface AgentRow {
  id: string
  owner_address: string
  status: string
  budget_usdc: string
  spent_usdc: string
  /** CRITICAL-1: in-flight reservations not yet confirmed on-chain. */
  reserved_usdc: string
  max_per_tx_usdc: string
  daily_limit_usdc: string
  monthly_limit_usdc: string
  daily_spent_usdc: string
  monthly_spent_usdc: string
  daily_reset_at: string
  monthly_reset_at: string
  allowed_recipients: string
  allowed_purposes: string
  require_approval_above_usdc: string
}

function n(v: string): number { return parseFloat(v) || 0 }

export function evaluatePolicy(
  agent: AgentRow,
  amount_usdc: string,
  recipient: string,
  purpose: string,
): PolicyResult {
  const checks: PolicyCheck[] = []
  let rejected = false
  let rejection_reason: string | null = null

  const amount = n(amount_usdc)
  const now = new Date()

  // Reset daily/monthly counters if windows have elapsed
  const dailyReset = new Date(agent.daily_reset_at)
  const monthlyReset = new Date(agent.monthly_reset_at)
  const effectiveDailySpent   = now >= dailyReset   ? 0 : n(agent.daily_spent_usdc)
  const effectiveMonthlySpent = now >= monthlyReset ? 0 : n(agent.monthly_spent_usdc)

  // 1. Agent must be active
  const agentActive = agent.status === 'active'
  checks.push({
    rule: 'agent_active',
    passed: agentActive,
    detail: agentActive ? 'Agent is active' : `Agent is ${agent.status}`,
  })
  if (!agentActive) { rejected = true; rejection_reason = `Agent is ${agent.status}` }

  // 2. Amount must be positive
  const positive = amount > 0
  checks.push({ rule: 'positive_amount', passed: positive, detail: positive ? `Amount ${amount_usdc} USDC > 0` : 'Amount must be positive' })
  if (!positive) { rejected = true; rejection_reason = rejection_reason ?? 'Amount must be positive' }

  // 3. Per-transaction cap
  const perTxOk = amount <= n(agent.max_per_tx_usdc)
  checks.push({
    rule: 'per_tx_limit',
    passed: perTxOk,
    detail: perTxOk
      ? `${amount_usdc} USDC ≤ max ${agent.max_per_tx_usdc} USDC`
      : `${amount_usdc} USDC exceeds per-tx limit of ${agent.max_per_tx_usdc} USDC`,
  })
  if (!perTxOk) { rejected = true; rejection_reason = rejection_reason ?? `Exceeds per-transaction limit of ${agent.max_per_tx_usdc} USDC` }

  // 4. Remaining budget — enforced against spent + reserved (in-flight) combined.
  //    This is the CRITICAL-1 fix: reserved_usdc covers authorized-but-unconfirmed payments,
  //    preventing concurrent requests from collectively exceeding the budget.
  const committedUsdc = n(agent.spent_usdc) + n(agent.reserved_usdc)
  const remaining = n(agent.budget_usdc) - committedUsdc
  const budgetOk = amount <= remaining
  checks.push({
    rule: 'remaining_budget',
    passed: budgetOk,
    detail: budgetOk
      ? `${amount_usdc} USDC ≤ available ${remaining.toFixed(6)} USDC (budget ${agent.budget_usdc} − spent ${agent.spent_usdc} − reserved ${agent.reserved_usdc})`
      : `${amount_usdc} USDC exceeds available ${remaining.toFixed(6)} USDC (budget ${agent.budget_usdc} − spent ${agent.spent_usdc} − reserved ${agent.reserved_usdc})`,
  })
  if (!budgetOk) { rejected = true; rejection_reason = rejection_reason ?? `Insufficient budget (${remaining.toFixed(2)} USDC available)` }

  // 5. Daily limit
  const dailyOk = effectiveDailySpent + amount <= n(agent.daily_limit_usdc)
  checks.push({
    rule: 'daily_limit',
    passed: dailyOk,
    detail: dailyOk
      ? `Daily: ${effectiveDailySpent.toFixed(2)} + ${amount_usdc} ≤ ${agent.daily_limit_usdc} USDC`
      : `Would exceed daily limit of ${agent.daily_limit_usdc} USDC`,
  })
  if (!dailyOk) { rejected = true; rejection_reason = rejection_reason ?? `Exceeds daily limit of ${agent.daily_limit_usdc} USDC` }

  // 6. Monthly limit
  const monthlyOk = effectiveMonthlySpent + amount <= n(agent.monthly_limit_usdc)
  checks.push({
    rule: 'monthly_limit',
    passed: monthlyOk,
    detail: monthlyOk
      ? `Monthly: ${effectiveMonthlySpent.toFixed(2)} + ${amount_usdc} ≤ ${agent.monthly_limit_usdc} USDC`
      : `Would exceed monthly limit of ${agent.monthly_limit_usdc} USDC`,
  })
  if (!monthlyOk) { rejected = true; rejection_reason = rejection_reason ?? `Exceeds monthly limit of ${agent.monthly_limit_usdc} USDC` }

  // 7. Recipient allowlist (only enforced when non-empty)
  const allowedRecipients: string[] = JSON.parse(agent.allowed_recipients || '[]')
  if (allowedRecipients.length > 0) {
    const recipientOk = allowedRecipients.some(
      r => r.toLowerCase() === recipient.toLowerCase(),
    )
    checks.push({
      rule: 'recipient_allowlist',
      passed: recipientOk,
      detail: recipientOk
        ? `Recipient ${recipient} is on the allowlist`
        : `Recipient ${recipient} is not on the allowlist`,
    })
    if (!recipientOk) { rejected = true; rejection_reason = rejection_reason ?? `Recipient ${recipient} not permitted` }
  } else {
    checks.push({ rule: 'recipient_allowlist', passed: true, detail: 'No recipient restrictions' })
  }

  // 8. Purpose allowlist (only enforced when non-empty)
  const allowedPurposes: string[] = JSON.parse(agent.allowed_purposes || '[]')
  if (allowedPurposes.length > 0) {
    const purposeOk = allowedPurposes.includes(purpose)
    checks.push({
      rule: 'purpose_allowlist',
      passed: purposeOk,
      detail: purposeOk ? `Purpose "${purpose}" is allowed` : `Purpose "${purpose}" is not in allowed list`,
    })
    if (!purposeOk) { rejected = true; rejection_reason = rejection_reason ?? `Purpose "${purpose}" not permitted` }
  } else {
    checks.push({ rule: 'purpose_allowlist', passed: true, detail: 'No purpose restrictions' })
  }

  // Human approval threshold
  const requiresApproval = !rejected && amount > n(agent.require_approval_above_usdc)

  return {
    approved: !rejected,
    checks,
    requires_human_approval: requiresApproval,
    rejection_reason,
  }
}
