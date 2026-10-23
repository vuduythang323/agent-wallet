import { useState } from 'react'
import { ShieldCheck, CheckCircle, XCircle, AlertTriangle } from 'lucide-react'
import { useAgents, useUpdatePolicy } from '@/hooks/useAgents'
import { StatusBadge } from './StatusBadge'
import { formatUsdc, budgetPct } from '@/lib/utils'
import type { Agent } from '@/lib/api'
import { useAccount } from 'wagmi'

export function PolicyPage() {
  const { isConnected } = useAccount()
  const { data: agents = [], isLoading } = useAgents()
  const updatePolicy = useUpdatePolicy()
  const [selected, setSelected] = useState<string | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  if (!isConnected) {
    return <div className="flex items-center justify-center py-24 text-[var(--muted)]">Connect wallet to manage policies</div>
  }

  function startEdit(a: Agent) {
    setSelected(a.id)
    setForm({
      budget_usdc: a.budget_usdc,
      max_per_tx_usdc: a.max_per_tx_usdc,
      daily_limit_usdc: a.daily_limit_usdc,
      monthly_limit_usdc: a.monthly_limit_usdc,
      require_approval_above_usdc: a.require_approval_above_usdc,
    })
  }

  async function save() {
    if (!selected) return
    setSaving(true)
    try {
      await updatePolicy.mutateAsync({ id: selected, policy: form })
      setSelected(null)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="display text-2xl font-700 text-[var(--ink)] tracking-tight">Policy Settings</h1>
        <p className="text-sm text-[var(--muted)] mt-1">Configure spending rules enforced on every payment request</p>
      </div>

      {/* Policy engine info */}
      <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5">
        <h2 className="font-600 text-blue-800 mb-3 flex items-center gap-2">
          <ShieldCheck size={16} /> How the Policy Engine Works
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[
            ['Per-transaction cap', 'Rejects any payment over the configured per-tx limit'],
            ['Remaining budget', 'Blocks payments when the agent has exhausted its total budget'],
            ['Daily & monthly limits', 'Rolling windows reset automatically — prevents bursting'],
            ['Recipient allowlist', 'When set, blocks payments to any unlisted address'],
            ['Purpose allowlist', 'Restricts the types of services an agent may pay for'],
            ['Human approval', 'Payments above a threshold require user sign-off'],
            ['Idempotency', 'Duplicate requests with the same key return the original result'],
            ['Fail-closed', 'Any policy engine error results in a rejected payment'],
          ].map(([title, desc]) => (
            <div key={title} className="flex items-start gap-2">
              <CheckCircle size={14} className="text-blue-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-600 text-blue-900">{title}</p>
                <p className="text-xs text-blue-700">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Agent policy cards */}
      {isLoading ? (
        <div className="space-y-3">
          {([0,1]).map((i) => <div key={i} className="h-40 rounded-2xl bg-white/60 animate-pulse border border-[var(--border)]" />)}
        </div>
      ) : agents.length === 0 ? (
        <div className="text-center py-12 text-[var(--muted)]">
          <ShieldCheck size={36} className="mx-auto mb-3 opacity-30" />
          <p>No agents to configure. Create an agent first.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {agents.map(a => (
            <div key={a.id} className="bg-white/80 backdrop-blur rounded-2xl border border-[var(--border)] p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <h3 className="font-600 text-[var(--ink)]">{a.name}</h3>
                  <StatusBadge status={a.status} />
                </div>
                {a.status !== 'revoked' && selected !== a.id && (
                  <button onClick={() => startEdit(a)} className="px-3 py-1.5 rounded-lg border border-[var(--border)] text-xs font-600 text-[var(--ink)] hover:bg-[var(--surface-muted)] transition-colors">
                    Edit
                  </button>
                )}
              </div>

              {/* Budget bar */}
              <div className="mb-4">
                <div className="flex justify-between text-xs text-[var(--muted)] mb-1">
                  <span>Budget usage</span>
                  <span className="tabular-nums">{budgetPct(a.spent_usdc, a.budget_usdc).toFixed(0)}%</span>
                </div>
                <div className="h-1.5 bg-[var(--surface-muted)] rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${budgetPct(a.spent_usdc, a.budget_usdc) > 90 ? 'bg-red-500' : 'bg-[var(--accent)]'}`}
                    style={{ width: `${budgetPct(a.spent_usdc, a.budget_usdc)}%` }}
                  />
                </div>
              </div>

              {selected === a.id ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      ['budget_usdc','Total Budget (USDC)'],
                      ['max_per_tx_usdc','Max Per Transaction'],
                      ['daily_limit_usdc','Daily Limit'],
                      ['monthly_limit_usdc','Monthly Limit'],
                      ['require_approval_above_usdc','Require Approval Above'],
                    ].map(([key, label]) => (
                      <div key={key}>
                        <label className="block text-xs font-medium text-[var(--muted)] mb-1">{label}</label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)] text-sm">$</span>
                          <input type="number" min="0" step="0.01"
                            className="w-full pl-6 pr-3 py-2 rounded-lg border border-[var(--border)] text-sm bg-white focus:outline-none focus:border-[var(--accent)] tabular-nums"
                            value={form[key] ?? ''} onChange={e => setForm(f => ({...f, [key]: e.target.value}))} />
                        </div>
                      </div>
                    ))}
                  </div>
                  {parseFloat(form.require_approval_above_usdc) < parseFloat(form.max_per_tx_usdc) && (
                    <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      <AlertTriangle size={12} />
                      Approval threshold is lower than max-per-tx — all transactions will require approval
                    </div>
                  )}
                  <div className="flex gap-3">
                    <button onClick={() => setSelected(null)} className="flex-1 py-2 rounded-xl border border-[var(--border)] text-sm font-600 text-[var(--muted)] hover:bg-[var(--surface-muted)] transition-colors">Cancel</button>
                    <button onClick={() => { void save() }} disabled={saving} className="flex-1 py-2 rounded-xl bg-[var(--accent)] text-white text-sm font-600 hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-60">
                      {saving ? 'Saving…' : 'Save Policy'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-3">
                  {[
                    ['Budget', `$${formatUsdc(a.budget_usdc)}`],
                    ['Max / tx', `$${formatUsdc(a.max_per_tx_usdc)}`],
                    ['Daily', `$${formatUsdc(a.daily_limit_usdc)}`],
                    ['Monthly', `$${formatUsdc(a.monthly_limit_usdc)}`],
                    ['Approval >', `$${formatUsdc(a.require_approval_above_usdc)}`],
                    ['Recipients', a.allowed_recipients.length === 0 ? 'Any' : `${a.allowed_recipients.length} listed`],
                  ].map(([label, val]) => (
                    <div key={label} className="bg-[var(--surface-muted)] rounded-xl px-3 py-2">
                      <p className="text-xs text-[var(--subtle)]">{label}</p>
                      <p className="text-sm font-600 text-[var(--ink)] tabular-nums">{val}</p>
                    </div>
                  ))}
                </div>
              )}

              {a.allowed_recipients.length > 0 && (
                <div className="mt-3 pt-3 border-t border-[var(--border)]">
                  <p className="text-xs text-[var(--muted)] mb-2">Allowlisted recipients ({a.allowed_recipients.length})</p>
                  <div className="flex flex-wrap gap-1">
                    {a.allowed_recipients.map(r => (
                      <code key={r} className="mono text-xs bg-[var(--surface-muted)] px-2 py-0.5 rounded">{r.slice(0,10)}…</code>
                    ))}
                  </div>
                </div>
              )}

              {a.status === 'revoked' && (
                <div className="mt-3 flex items-center gap-2 text-xs text-red-600">
                  <XCircle size={12} /> This agent is revoked and cannot make payments
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
