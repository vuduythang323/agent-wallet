import { useState } from 'react'
import { useAccount } from 'wagmi'
import { Bot, Plus, Pause, Play, Ban, ChevronRight, Copy, Check } from 'lucide-react'
import { useAgents, useCreateAgent, usePauseAgent, useResumeAgent, useRevokeAgent } from '@/hooks/useAgents'
import { StatusBadge } from './StatusBadge'
import { AgentDetailPage } from './AgentDetailPage'
import { cn, formatUsdc, relativeTime, budgetPct } from '@/lib/utils'
import type { Agent } from '@/lib/api'

export function AgentsPage() {
  const { isConnected } = useAccount()
  const { data: agents = [], isLoading } = useAgents()
  const createAgent = useCreateAgent()
  const pauseAgent = usePauseAgent()
  const resumeAgent = useResumeAgent()
  const revokeAgent = useRevokeAgent()

  const [creating, setCreating] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [newApiKey, setNewApiKey] = useState<{ key: string; agent_name: string } | null>(null)
  const [copied, setCopied] = useState(false)

  // Form state
  const [form, setForm] = useState({
    name: '', description: '',
    budget_usdc: '10', max_per_tx_usdc: '1',
    daily_limit_usdc: '5', monthly_limit_usdc: '50',
    require_approval_above_usdc: '5',
  })

  if (!isConnected) {
    return <div className="flex items-center justify-center py-24 text-[var(--muted)]">Connect wallet to manage agents</div>
  }

  if (selectedAgent) {
    return <AgentDetailPage agentId={selectedAgent} onBack={() => setSelectedAgent(null)} />
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const result = await createAgent.mutateAsync({
      name: form.name, description: form.description,
      policy: {
        budget_usdc: form.budget_usdc,
        max_per_tx_usdc: form.max_per_tx_usdc,
        daily_limit_usdc: form.daily_limit_usdc,
        monthly_limit_usdc: form.monthly_limit_usdc,
        require_approval_above_usdc: form.require_approval_above_usdc,
      },
    })
    setNewApiKey({ key: result.api_key, agent_name: result.agent.name })
    setCreating(false)
    setForm({ name: '', description: '', budget_usdc: '10', max_per_tx_usdc: '1', daily_limit_usdc: '5', monthly_limit_usdc: '50', require_approval_above_usdc: '5' })
  }

  function handleCopy(key: string) {
    void navigator.clipboard.writeText(key)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="display text-2xl font-700 text-[var(--ink)] tracking-tight">Agents</h1>
          <p className="text-sm text-[var(--muted)] mt-1">Manage AI agents and their spending policies</p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--accent)] text-white text-sm font-600 hover:bg-[var(--accent-hover)] transition-colors"
        >
          <Plus size={16} /> New Agent
        </button>
      </div>

      {/* New API Key modal */}
      {newApiKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 max-w-md w-full space-y-4">
            <h2 className="display text-xl font-700 text-[var(--ink)]">API Key Created</h2>
            <p className="text-sm text-[var(--muted)]">
              This is the only time you will see this key. Copy it now and store it securely.
            </p>
            <div className="bg-[var(--surface-muted)] rounded-xl p-3 flex items-center gap-2">
              <code className="mono text-xs flex-1 text-[var(--ink)] break-all">{newApiKey.key}</code>
              <button onClick={() => handleCopy(newApiKey.key)} className="p-2 rounded-lg hover:bg-white transition-colors text-[var(--muted)]">
                {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
              </button>
            </div>
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Store this key in your environment variables as <code className="mono">AGENTPAY_API_KEY</code>
            </p>
            <button
              onClick={() => setNewApiKey(null)}
              className="w-full py-2.5 rounded-xl bg-[var(--accent)] text-white text-sm font-600 hover:bg-[var(--accent-hover)] transition-colors"
            >
              Done — I saved my key
            </button>
          </div>
        </div>
      )}

      {/* Create agent form */}
      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 max-w-md w-full">
            <h2 className="display text-xl font-700 text-[var(--ink)] mb-5">Create Agent</h2>
            <form onSubmit={(e) => { void handleCreate(e) }} className="space-y-4">
              <Field label="Name" required>
                <input
                  className="w-full px-3 py-2 rounded-lg border border-[var(--border)] text-sm bg-white focus:outline-none focus:border-[var(--accent)] transition-colors"
                  value={form.name} onChange={e => setForm(f => ({...f, name: e.target.value}))}
                  placeholder="My Research Agent" required
                />
              </Field>
              <Field label="Description">
                <input
                  className="w-full px-3 py-2 rounded-lg border border-[var(--border)] text-sm bg-white focus:outline-none focus:border-[var(--accent)] transition-colors"
                  value={form.description} onChange={e => setForm(f => ({...f, description: e.target.value}))}
                  placeholder="Calls paid data APIs"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Budget (USDC)">
                  <input type="number" min="0" step="0.01" className="w-full px-3 py-2 rounded-lg border border-[var(--border)] text-sm bg-white focus:outline-none focus:border-[var(--accent)] tabular-nums"
                    value={form.budget_usdc} onChange={e => setForm(f => ({...f, budget_usdc: e.target.value}))} />
                </Field>
                <Field label="Max per tx">
                  <input type="number" min="0" step="0.01" className="w-full px-3 py-2 rounded-lg border border-[var(--border)] text-sm bg-white focus:outline-none focus:border-[var(--accent)] tabular-nums"
                    value={form.max_per_tx_usdc} onChange={e => setForm(f => ({...f, max_per_tx_usdc: e.target.value}))} />
                </Field>
                <Field label="Daily limit">
                  <input type="number" min="0" step="0.01" className="w-full px-3 py-2 rounded-lg border border-[var(--border)] text-sm bg-white focus:outline-none focus:border-[var(--accent)] tabular-nums"
                    value={form.daily_limit_usdc} onChange={e => setForm(f => ({...f, daily_limit_usdc: e.target.value}))} />
                </Field>
                <Field label="Monthly limit">
                  <input type="number" min="0" step="0.01" className="w-full px-3 py-2 rounded-lg border border-[var(--border)] text-sm bg-white focus:outline-none focus:border-[var(--accent)] tabular-nums"
                    value={form.monthly_limit_usdc} onChange={e => setForm(f => ({...f, monthly_limit_usdc: e.target.value}))} />
                </Field>
              </div>
              <Field label="Require approval above (USDC)">
                <input type="number" min="0" step="0.01" className="w-full px-3 py-2 rounded-lg border border-[var(--border)] text-sm bg-white focus:outline-none focus:border-[var(--accent)] tabular-nums"
                  value={form.require_approval_above_usdc} onChange={e => setForm(f => ({...f, require_approval_above_usdc: e.target.value}))} />
              </Field>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setCreating(false)} className="flex-1 py-2.5 rounded-xl border border-[var(--border)] text-sm font-600 text-[var(--muted)] hover:bg-[var(--surface-muted)] transition-colors">Cancel</button>
                <button type="submit" disabled={createAgent.isPending} className="flex-1 py-2.5 rounded-xl bg-[var(--accent)] text-white text-sm font-600 hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-60">
                  {createAgent.isPending ? 'Creating…' : 'Create Agent'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Agent list */}
      {isLoading ? (
        <div className="space-y-3">
          {([0,1,2]).map((i) => <div key={i} className="h-24 rounded-2xl bg-white/60 animate-pulse border border-[var(--border)]" />)}
        </div>
      ) : agents.length === 0 ? (
        <div className="text-center py-16 text-[var(--muted)]">
          <Bot size={40} className="mx-auto mb-3 opacity-30" />
          <p className="font-medium">No agents yet</p>
          <p className="text-sm mt-1">Create an agent to start delegating payments</p>
        </div>
      ) : (
        <div className="space-y-3">
          {agents.map(agent => (
            <AgentCard
              key={agent.id} agent={agent}
              onSelect={() => setSelectedAgent(agent.id)}
              onPause={() => pauseAgent.mutate(agent.id)}
              onResume={() => resumeAgent.mutate(agent.id)}
              onRevoke={() => { if (confirm(`Revoke agent "${agent.name}"? This cannot be undone.`)) revokeAgent.mutate(agent.id) }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function AgentCard({ agent, onSelect, onPause, onResume, onRevoke }: {
  agent: Agent
  onSelect: () => void
  onPause: () => void
  onResume: () => void
  onRevoke: () => void
}) {
  const pct = budgetPct(agent.spent_usdc, agent.budget_usdc)
  return (
    <div className={cn('bg-white/80 backdrop-blur rounded-2xl border p-5 transition-all', agent.status === 'revoked' ? 'border-red-100 opacity-60' : 'border-[var(--border)]')}>
      <div className="flex items-start gap-3">
        <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center text-white text-lg font-700 flex-shrink-0',
          agent.status === 'active' ? 'bg-[var(--accent)]' : agent.status === 'paused' ? 'bg-amber-500' : 'bg-red-400',
        )}>
          {agent.name.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-600 text-[var(--ink)]">{agent.name}</h3>
            <StatusBadge status={agent.status} />
          </div>
          {agent.description && <p className="text-sm text-[var(--muted)] mt-0.5 truncate">{agent.description}</p>}
          <div className="mt-3">
            <div className="flex justify-between text-xs text-[var(--subtle)] mb-1">
              <span>Budget used</span>
              <span className="tabular-nums">${formatUsdc(agent.spent_usdc)} / ${formatUsdc(agent.budget_usdc)}</span>
            </div>
            <div className="h-1.5 bg-[var(--surface-muted)] rounded-full overflow-hidden">
              <div className={cn('h-full rounded-full transition-all', pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-[var(--accent)]')} style={{ width: `${pct}%` }} />
            </div>
          </div>
        </div>
        {/* Actions */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {agent.status === 'active' && (
            <IconBtn onClick={onPause} title="Pause"><Pause size={14} /></IconBtn>
          )}
          {agent.status === 'paused' && (
            <IconBtn onClick={onResume} title="Resume"><Play size={14} /></IconBtn>
          )}
          {agent.status !== 'revoked' && (
            <IconBtn onClick={onRevoke} title="Revoke" danger><Ban size={14} /></IconBtn>
          )}
          <IconBtn onClick={onSelect} title="View detail"><ChevronRight size={14} /></IconBtn>
        </div>
      </div>
      <div className="mt-3 flex gap-4 text-xs text-[var(--subtle)]">
        <span>Max/tx: <span className="tabular-nums text-[var(--muted)] font-medium">${formatUsdc(agent.max_per_tx_usdc)}</span></span>
        <span>Daily: <span className="tabular-nums text-[var(--muted)] font-medium">${formatUsdc(agent.daily_limit_usdc)}</span></span>
        <span>Created: <span className="text-[var(--muted)] font-medium">{relativeTime(agent.created_at)}</span></span>
      </div>
    </div>
  )
}

function IconBtn({ onClick, title, danger, children }: { onClick: () => void; title: string; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick} title={title}
      className={cn('p-2 rounded-lg transition-colors',
        danger
          ? 'text-red-400 hover:bg-red-50 hover:text-red-600'
          : 'text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--ink)]',
      )}
    >
      {children}
    </button>
  )
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-[var(--muted)] mb-1">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  )
}
