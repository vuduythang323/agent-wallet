// ─── Shared domain types used by both frontend and server ──────────────────

export type AgentStatus = 'active' | 'paused' | 'revoked'
export type PaymentStatus =
  | 'REQUESTED'
  | 'POLICY_CHECK'
  | 'AWAITING_APPROVAL'
  | 'AUTHORIZED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'FAILED'
  | 'REJECTED'

export interface SpendingPolicy {
  budget_usdc: string           // total budget in USDC (decimal string)
  spent_usdc: string            // amount spent so far
  max_per_tx_usdc: string       // per-transaction cap
  daily_limit_usdc: string      // rolling 24h cap
  monthly_limit_usdc: string    // rolling 30-day cap
  daily_spent_usdc: string      // spent in last 24h
  monthly_spent_usdc: string    // spent in last 30 days
  allowed_recipients: string[]  // empty = any; non-empty = allowlist
  allowed_purposes: string[]    // e.g. ['api', 'data', 'compute']
  require_approval_above_usdc: string // payments above this need human approval
}

export interface Agent {
  id: string
  owner_address: string
  name: string
  description: string
  status: AgentStatus
  api_key_hash: string          // bcrypt hash; plaintext shown once at creation
  policy: SpendingPolicy
  created_at: string
  updated_at: string
}

export interface AgentCreateRequest {
  name: string
  description?: string
  policy: Partial<SpendingPolicy>
}

export interface PaymentRequest {
  id: string
  agent_id: string
  owner_address: string
  recipient: string
  amount_usdc: string
  purpose: string
  idempotency_key: string
  status: PaymentStatus
  policy_result: PolicyResult | null
  tx_hash: string | null
  block_number: number | null
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface PolicyResult {
  approved: boolean
  checks: PolicyCheck[]
  requires_human_approval: boolean
  rejection_reason: string | null
}

export interface PolicyCheck {
  rule: string
  passed: boolean
  detail: string
}

export interface ApiKeyInfo {
  key: string          // plaintext — shown exactly once
  agent_id: string
  agent_name: string
}

export interface AuditLog {
  id: string
  agent_id: string | null
  payment_id: string | null
  actor: string        // 'agent' | 'user' | 'system'
  action: string
  detail: string
  ip: string | null
  created_at: string
}
