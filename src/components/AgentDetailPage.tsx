import { useState } from 'react'
import { ArrowLeft, Save, Plus, X } from 'lucide-react'
import { useAgent, useUpdatePolicy } from '@/hooks/useAgents'
import { usePayments } from '@/hooks/usePayments'
import { StatusBadge } from './StatusBadge'
import { formatAddress, formatUsdc, relativeTime, budgetPct } from '@/lib/utils'
import { buildTxExplorerUrl } from '@/onchain-facts'
import { ExternalLink } from 'lucide-react'

const ARC_CHAIN_ID = 5042002

interface Props {
  agentId: string
  onBack: () => void
}

export function AgentDetailPage({ agentId, onBack }: Props) {
  const { data: agent, isLoading } = useAgent(agentId)
  const { data: payments = [] } = usePayments({ agent_id: agentId })
  const updatePolicy = useUpdatePolicy()

  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})
  const [newRecipient, setNewRecipient] = useState('')
  const [newPurpose, setNewPurpose] = useState('')

  if (isLoading) return <div className="flex items-center justify-center py-24"><div className="w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" /></div>
  if (!agent) return null

  function startEdit() {
    setForm({
      budget_usdc: agent!.budget_usdc,
      max_per_tx_usdc: agent!.max_per_tx_usdc,
      daily_limit_usdc: agent!.daily_limit_usdc,
      monthly_limit_usdc: agent!.monthly_limit_usdc,
      require_approval_above_usdc: agent!.require_approval_above_usdc,
    })
    setEditing(true)
  }

  async function savePolicy() {
    const policy: Partial<import('@/lib/api').Agent> = {
      ...form,
      allowed_recipients: agent!.allowed_recipients,
      allowed_purposes: agent!.allowed_purposes,
    }
    await updatePolicy.mutateAsync({ id: agentId, policy })
    setEditing(false)
  }

  async function addRecipient() {
    if (!newRecipient || !/^0x[0-9a-fA-F]{40}$/.test(newRecipient)) return
    await updatePolicy.mutateAsync({
      id: agentId,
      policy: { allowed_recipients: [...agent!.allowed_recipients, newRecipient] },
    })
    setNewRecipient('')
  }

  async function removeRecipient(addr: string) {
    await updatePolicy.mutateAsync({
      id: agentId,
      policy: { allowed_recipients: agent!.allowed_recipients.filter(r => r !== addr) },
    })
  }

  async function addPurpose() {
    if (!newPurpose.trim()) return
    await updatePolicy.mutateAsync({
      id: agentId,
      policy: { allowed_purposes: [...agent!.allowed_purposes, newPurpose.trim()] },
    })
    setNewPurpose('')
  }

  async function removePurpose(p: string) {
    await updatePolicy.mutateAsync({
      id: agentId,
      policy: { allowed_purposes: agent!.allowed_purposes.filter(x => x !== p) },
    })
  }

  const pct = budgetPct(agent.spent_usdc, agent.budget_usdc)

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="p-2 rounded-lg hover:bg-[var(--surface-muted)] text-[var(--muted)] transition-colors">
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="display text-2xl font-700 text-[var(--ink)]">{agent.name}</h1>
            <StatusBadge status={agent.status} />
          </div>
          {agent.description && <p className="text-sm text-[var(--muted)] mt-0.5">{agent.description}</p>}
        </div>
        {agent.status !== 'revoked' && !editing && (
          <button onClick={startEdit} className="px-4 py-2 rounded-xl border border-[var(--border)] text-sm font-600 text-[var(--ink)] hover:bg-[var(--surface-muted)] transition-colors">
            Edit Policy
          </button>
        )}
      </div>

      {/* Budget card */}
      <div className="bg-white/80 backdrop-blur rounded-2xl border border-[var(--border)] p-5">
        <h2 className="font-600 text-[var(--ink)] mb-4">Budget & Spending</h2>
        <div className="mb-3">
          <div className="flex justify-between text-sm mb-2">
            <span className="text-[var(--muted)]">Used</span>
            <span className="tabular-nums font-600">${formatUsdc(agent.spent_usdc)} / ${formatUsdc(agent.budget_usdc)}</span>
          </div>
          <div className="h-2 bg-[var(--surface-muted)] rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-[var(--accent)]'}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="text-xs text-[var(--subtle)] mt-1">{(100 - pct).toFixed(0)}% remaining</div>
        </div>
        {editing ? (
          <div className="grid grid-cols-2 gap-3 mt-4">
            {[
              ['budget_usdc','Total Budget'],['max_per_tx_usdc','Max Per Tx'],
              ['daily_limit_usdc','Daily Limit'],['monthly_limit_usdc','Monthly Limit'],
              ['require_approval_above_usdc','Approval Above'],
            ].map(([key, label]) => (
              <div key={key}>
                <label className="block text-xs font-medium text-[var(--muted)] mb-1">{label}</label>
                <input type="number" min="0" step="0.01"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--border)] text-sm bg-white focus:outline-none focus:border-[var(--accent)] tabular-nums"
                  value={form[key] ?? ''} onChange={e => setForm(f => ({...f, [key]: e.target.value}))} />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3 mt-4">
            {[
              ['Max per tx', agent.max_per_tx_usdc],
              ['Daily limit', agent.daily_limit_usdc],
              ['Monthly limit', agent.monthly_limit_usdc],
              ['Approval above', agent.require_approval_above_usdc],
              ['Daily spent', agent.daily_spent_usdc],
              ['Monthly spent', agent.monthly_spent_usdc],
            ].map(([label, val]) => (
              <div key={label} className="bg-[var(--surface-muted)] rounded-xl px-3 py-2">
                <p className="text-xs text-[var(--subtle)]">{label}</p>
                <p className="tabular-nums text-sm font-600 text-[var(--ink)]">${formatUsdc(val)}</p>
              </div>
            ))}
          </div>
        )}
        {editing && (
          <div className="flex gap-3 mt-4">
            <button onClick={() => setEditing(false)} className="flex-1 py-2 rounded-xl border border-[var(--border)] text-sm font-600 text-[var(--muted)] hover:bg-[var(--surface-muted)] transition-colors">Cancel</button>
            <button onClick={() => { void savePolicy() }} disabled={updatePolicy.isPending} className="flex-1 py-2 rounded-xl bg-[var(--accent)] text-white text-sm font-600 hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-60 flex items-center justify-center gap-2">
              <Save size={14} />{updatePolicy.isPending ? 'Saving…' : 'Save Policy'}
            </button>
          </div>
        )}
      </div>

      {/* Recipient allowlist */}
      <div className="bg-white/80 backdrop-blur rounded-2xl border border-[var(--border)] p-5">
        <h2 className="font-600 text-[var(--ink)] mb-1">Recipient Allowlist</h2>
        <p className="text-xs text-[var(--muted)] mb-4">{agent.allowed_recipients.length === 0 ? 'All recipients allowed (no restrictions)' : 'Only these addresses may receive payments'}</p>
        <div className="space-y-2 mb-3">
          {agent.allowed_recipients.map(r => (
            <div key={r} className="flex items-center justify-between bg-[var(--surface-muted)] rounded-lg px-3 py-2">
              <code className="mono text-xs text-[var(--ink)]">{r}</code>
              <button onClick={() => { void removeRecipient(r) }} className="text-[var(--muted)] hover:text-red-500 transition-colors ml-2"><X size={14} /></button>
            </div>
          ))}
        </div>
        {agent.status !== 'revoked' && (
          <div className="flex gap-2">
            <input
              className="flex-1 px-3 py-2 rounded-lg border border-[var(--border)] text-sm mono bg-white focus:outline-none focus:border-[var(--accent)]"
              placeholder="0x..." value={newRecipient} onChange={e => setNewRecipient(e.target.value)}
            />
            <button onClick={() => { void addRecipient() }} className="px-3 py-2 rounded-lg bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"><Plus size={14} /></button>
          </div>
        )}
      </div>

      {/* Purpose allowlist */}
      <div className="bg-white/80 backdrop-blur rounded-2xl border border-[var(--border)] p-5">
        <h2 className="font-600 text-[var(--ink)] mb-1">Allowed Purposes</h2>
        <p className="text-xs text-[var(--muted)] mb-4">{agent.allowed_purposes.length === 0 ? 'All purposes allowed' : 'Only these purposes are permitted'}</p>
        <div className="flex flex-wrap gap-2 mb-3">
          {agent.allowed_purposes.map(p => (
            <span key={p} className="flex items-center gap-1 px-2 py-1 rounded-full bg-[var(--surface-muted)] text-xs font-medium text-[var(--ink)]">
              {p}
              <button onClick={() => { void removePurpose(p) }} className="text-[var(--muted)] hover:text-red-500 ml-0.5"><X size={10} /></button>
            </span>
          ))}
        </div>
        {agent.status !== 'revoked' && (
          <div className="flex gap-2">
            <input
              className="flex-1 px-3 py-2 rounded-lg border border-[var(--border)] text-sm bg-white focus:outline-none focus:border-[var(--accent)]"
              placeholder="api, data, compute…" value={newPurpose} onChange={e => setNewPurpose(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void addPurpose() }}}
            />
            <button onClick={() => { void addPurpose() }} className="px-3 py-2 rounded-lg bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"><Plus size={14} /></button>
          </div>
        )}
      </div>

      {/* Payment history */}
      <div className="bg-white/80 backdrop-blur rounded-2xl border border-[var(--border)] p-5">
        <h2 className="font-600 text-[var(--ink)] mb-4">Payment History ({payments.length})</h2>
        {payments.length === 0 ? (
          <p className="text-sm text-[var(--muted)] text-center py-6">No payments yet</p>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {payments.map(p => (
              <div key={p.id} className="flex items-center gap-3 py-3">
                <StatusBadge status={p.status} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--ink)] truncate mono">{formatAddress(p.recipient)}</p>
                  <p className="text-xs text-[var(--subtle)]">{p.purpose} · {relativeTime(p.created_at)}</p>
                </div>
                <span className="tabular-nums text-sm font-600">${formatUsdc(p.amount_usdc)}</span>
                {p.tx_hash && (
                  <a href={buildTxExplorerUrl(ARC_CHAIN_ID, p.tx_hash)} target="_blank" rel="noopener noreferrer" className="text-[var(--muted)] hover:text-[var(--accent)] transition-colors">
                    <ExternalLink size={14} />
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
