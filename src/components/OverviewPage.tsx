import { useAccount } from 'wagmi'
import { useReadContract } from 'wagmi'
import { erc20Abi } from 'viem'
import { getUsdc, requireChain, buildTxExplorerUrl } from '@/onchain-facts'
import { Amount, usdcDecimalsFor } from '@/onchain-money'
import { useAgents } from '@/hooks/useAgents'
import { usePayments } from '@/hooks/usePayments'
import { StatusBadge } from './StatusBadge'
import { formatAddress, formatUsdc, relativeTime, budgetPct } from '@/lib/utils'
import { TokenUSDC } from '@web3icons/react'
import { Bot, CreditCard, CheckCircle, Clock, TrendingUp, ExternalLink } from 'lucide-react'

const ARC_CHAIN_ID = 5042002

export function OverviewPage() {
  const { address, isConnected } = useAccount()

  const usdcFact = getUsdc(ARC_CHAIN_ID)
  const chain = requireChain(ARC_CHAIN_ID)

  const { data: rawBalance } = useReadContract({
    address: usdcFact?.address as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: ARC_CHAIN_ID,
    query: { enabled: isConnected && Boolean(address) },
  })

  const balance = rawBalance != null
    ? Amount.fromRaw(rawBalance, usdcDecimalsFor(ARC_CHAIN_ID)).toFixed(2)
    : null

  const { data: agents = [] } = useAgents()
  const { data: payments = [] } = usePayments()

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 text-center">
        <div className="w-16 h-16 rounded-2xl bg-[var(--surface-muted)] flex items-center justify-center">
          <Bot size={28} className="text-[var(--muted)]" />
        </div>
        <div>
          <h2 className="display text-2xl font-700 text-[var(--ink)] mb-2">Connect your wallet</h2>
          <p className="text-[var(--muted)] text-sm max-w-xs">
            Connect your EVM wallet to create agents, manage budgets, and track USDC payments on Arc Testnet.
          </p>
        </div>
        <div className="text-xs text-[var(--subtle)] bg-blue-50 border border-blue-100 rounded-lg px-4 py-2">
          Get test USDC from the sidebar "Get test USDC" button
        </div>
      </div>
    )
  }

  const activeAgents = agents.filter(a => a.status === 'active').length
  const pendingPayments = payments.filter(p => p.status === 'AWAITING_APPROVAL').length
  const confirmedPayments = payments.filter(p => p.status === 'CONFIRMED')
  const totalSpent = confirmedPayments
    .reduce((s, p) => s + parseFloat(p.amount_usdc), 0)
    .toFixed(2)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="display text-2xl font-700 text-[var(--ink)] tracking-tight">Overview</h1>
        <p className="text-sm text-[var(--muted)] mt-1">
          {formatAddress(address!)} on {chain.name}
        </p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* USDC Balance */}
        <div className="col-span-2 lg:col-span-1 bg-white/80 backdrop-blur rounded-2xl border border-[var(--border)] p-5">
          <div className="flex items-center gap-2 mb-3">
            <TokenUSDC variant="branded" size={20} />
            <span className="text-xs font-medium text-[var(--muted)] uppercase tracking-wider">USDC Balance</span>
          </div>
          <p className="display text-3xl font-700 text-[var(--ink)] tabular-nums">
            {balance ?? <span className="w-20 h-7 bg-[var(--surface-muted)] rounded animate-pulse inline-block" />}
          </p>
          <p className="text-xs text-[var(--subtle)] mt-1">Arc Testnet</p>
        </div>

        {/* Active agents */}
        <StatCard icon={Bot} label="Active Agents" value={activeAgents} color="blue" />
        {/* Pending approvals */}
        <StatCard icon={Clock} label="Pending Approval" value={pendingPayments} color="amber" />
        {/* Total spent */}
        <div className="bg-white/80 backdrop-blur rounded-2xl border border-[var(--border)] p-5">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp size={16} className="text-green-600" />
            <span className="text-xs font-medium text-[var(--muted)] uppercase tracking-wider">Total Spent</span>
          </div>
          <p className="display text-3xl font-700 text-[var(--ink)] tabular-nums">${totalSpent}</p>
          <p className="text-xs text-[var(--subtle)] mt-1">{confirmedPayments.length} payments</p>
        </div>
      </div>

      {/* Agent budget bars */}
      {agents.length > 0 && (
        <div className="bg-white/80 backdrop-blur rounded-2xl border border-[var(--border)] p-5">
          <h2 className="font-600 text-[var(--ink)] mb-4 flex items-center gap-2">
            <Bot size={16} /> Agent Budgets
          </h2>
          <div className="space-y-3">
            {agents.slice(0, 5).map(a => (
              <div key={a.id}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--ink)]">{a.name}</span>
                    <StatusBadge status={a.status} />
                  </div>
                  <span className="text-xs tabular-nums text-[var(--muted)]">
                    ${formatUsdc(a.spent_usdc)} / ${formatUsdc(a.budget_usdc)}
                  </span>
                </div>
                <div className="h-1.5 bg-[var(--surface-muted)] rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[var(--accent)] transition-all"
                    style={{ width: `${budgetPct(a.spent_usdc, a.budget_usdc)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent payments */}
      {payments.length > 0 && (
        <div className="bg-white/80 backdrop-blur rounded-2xl border border-[var(--border)] p-5">
          <h2 className="font-600 text-[var(--ink)] mb-4 flex items-center gap-2">
            <CreditCard size={16} /> Recent Payments
          </h2>
          <div className="divide-y divide-[var(--border)]">
            {payments.slice(0, 5).map(p => (
              <div key={p.id} className="flex items-center gap-3 py-3">
                <StatusBadge status={p.status} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--ink)] truncate">
                    {formatAddress(p.recipient)}
                  </p>
                  <p className="text-xs text-[var(--subtle)]">{relativeTime(p.created_at)}</p>
                </div>
                <span className="text-sm tabular-nums font-600 text-[var(--ink)]">${formatUsdc(p.amount_usdc)}</span>
                {p.tx_hash && (
                  <a
                    href={buildTxExplorerUrl(ARC_CHAIN_ID, p.tx_hash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--muted)] hover:text-[var(--accent)] transition-colors"
                    title="View on explorer"
                  >
                    <ExternalLink size={14} />
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {agents.length === 0 && payments.length === 0 && (
        <div className="text-center py-16 text-[var(--muted)]">
          <CheckCircle size={40} className="mx-auto mb-3 opacity-30" />
          <p className="font-medium">No agents yet</p>
          <p className="text-sm mt-1">Create your first agent to get started</p>
        </div>
      )}
    </div>
  )
}

function StatCard({ icon: Icon, label, value, color }: {
  icon: typeof Bot; label: string; value: number; color: string
}) {
  const colorMap: Record<string, string> = {
    blue: 'text-blue-600 bg-blue-50',
    amber: 'text-amber-600 bg-amber-50',
    green: 'text-green-600 bg-green-50',
  }
  return (
    <div className="bg-white/80 backdrop-blur rounded-2xl border border-[var(--border)] p-5">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-3 ${colorMap[color] ?? ''}`}>
        <Icon size={16} />
      </div>
      <p className="display text-3xl font-700 text-[var(--ink)] tabular-nums">{value}</p>
      <p className="text-xs text-[var(--muted)] mt-1">{label}</p>
    </div>
  )
}
