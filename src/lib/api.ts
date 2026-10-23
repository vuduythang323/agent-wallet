/**
 * Typed API client for AgentPay backend.
 * Attaches X-Owner-Address header automatically.
 */

export interface Agent {
  id: string
  owner_address: string
  name: string
  description: string
  status: 'active' | 'paused' | 'revoked'
  api_key_hash: string
  budget_usdc: string
  spent_usdc: string
  max_per_tx_usdc: string
  daily_limit_usdc: string
  monthly_limit_usdc: string
  daily_spent_usdc: string
  monthly_spent_usdc: string
  allowed_recipients: string[]
  allowed_purposes: string[]
  require_approval_above_usdc: string
  created_at: string
  updated_at: string
}

export interface PolicyCheck {
  rule: string
  passed: boolean
  detail: string
}

export interface PolicyResult {
  approved: boolean
  checks: PolicyCheck[]
  requires_human_approval: boolean
  rejection_reason: string | null
}

export interface Payment {
  id: string
  agent_id: string
  owner_address: string
  recipient: string
  amount_usdc: string
  purpose: string
  idempotency_key: string
  status: string
  policy_result: string | null
  tx_hash: string | null
  block_number: number | null
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface AuditEntry {
  id: string
  agent_id: string | null
  payment_id: string | null
  actor: string
  action: string
  detail: string
  ip: string | null
  created_at: string
}

// In production (Netlify + Railway split deploy), set VITE_API_BASE_URL to the
// Railway backend URL (e.g. https://agentpay-api.up.railway.app).
// Leave unset for local dev (uses Vite proxy) or single-origin HF deploy.
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? ''

class ApiClient {
  private ownerAddress: string | null = null
  private jwtToken: string | null = null

  setOwner(address: string) {
    this.ownerAddress = address.toLowerCase()
  }

  setToken(token: string) {
    this.jwtToken = token
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra }
    if (this.jwtToken) {
      h['Authorization'] = `Bearer ${this.jwtToken}`
    } else if (this.ownerAddress) {
      h['X-Owner-Address'] = this.ownerAddress
    }
    return h
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = await res.json() as T
    if (!res.ok) {
      const err = (data as { error?: string }).error ?? `HTTP ${res.status}`
      throw new Error(err)
    }
    return data
  }

  // Agents
  listAgents() { return this.req<Agent[]>('GET', '/api/agents') }
  getAgent(id: string) { return this.req<Agent>('GET', `/api/agents/${id}`) }
  createAgent(body: { name: string; description?: string; policy?: Partial<Agent> }) {
    return this.req<{ agent: Agent; api_key: string }>('POST', '/api/agents', body)
  }
  updatePolicy(id: string, policy: Partial<Agent>) {
    return this.req<Agent>('PATCH', `/api/agents/${id}/policy`, policy)
  }
  pauseAgent(id: string) { return this.req<{ success: boolean }>('POST', `/api/agents/${id}/pause`) }
  resumeAgent(id: string) { return this.req<{ success: boolean }>('POST', `/api/agents/${id}/resume`) }
  revokeAgent(id: string) { return this.req<{ success: boolean }>('POST', `/api/agents/${id}/revoke`) }

  // Payments
  listPayments(params?: { agent_id?: string; status?: string }) {
    const qs = new URLSearchParams(params).toString()
    return this.req<Payment[]>('GET', `/api/payments${qs ? `?${qs}` : ''}`)
  }
  getPayment(id: string) { return this.req<Payment>('GET', `/api/payments/${id}`) }
  approvePayment(id: string) { return this.req<{ success: boolean }>('POST', `/api/payments/${id}/approve`) }
  rejectPayment(id: string) { return this.req<{ success: boolean }>('POST', `/api/payments/${id}/reject`) }
  submitPayment(id: string, tx_hash: string) {
    return this.req<{ success: boolean }>('POST', `/api/payments/${id}/submit`, { tx_hash })
  }
  confirmPayment(id: string, block_number: number, amount_usdc: string) {
    return this.req<{ success: boolean }>('POST', `/api/payments/${id}/confirm`, { block_number, amount_usdc })
  }
  failPayment(id: string, error_message: string) {
    return this.req<{ success: boolean }>('POST', `/api/payments/${id}/fail`, { error_message })
  }

  // Audit
  listAudit(agent_id?: string) {
    const qs = agent_id ? `?agent_id=${agent_id}` : ''
    return this.req<AuditEntry[]>('GET', `/api/audit${qs}`)
  }
}

export const api = new ApiClient()
