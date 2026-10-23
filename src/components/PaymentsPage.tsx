import { useState } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { erc20Abi } from 'viem'
import { CreditCard, CheckCircle, XCircle, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react'
import { usePayments, useApprovePayment, useRejectPayment } from '@/hooks/usePayments'
import { api, type Payment, type PolicyResult } from '@/lib/api'
import { StatusBadge } from './StatusBadge'
import { formatAddress, formatUsdc, relativeTime } from '@/lib/utils'
import { buildTxExplorerUrl, getUsdc } from '@/onchain-facts'
import { parseAmount } from '@/onchain-money'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

function parsePolicyResult(raw: string | null): PolicyResult | null {
  if (!raw) return null
  try { return JSON.parse(raw) as PolicyResult } catch { return null }
}

const ARC_CHAIN_ID = 5042002

type FilterStatus = 'all' | 'AWAITING_APPROVAL' | 'AUTHORIZED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'REJECTED'

export function PaymentsPage() {
  const { address, isConnected } = useAccount()
  const [filter, setFilter] = useState<FilterStatus>('all')
  const { data: allPayments = [] } = usePayments()
  const approve = useApprovePayment()
  const reject = useRejectPayment()

  const payments = filter === 'all' ? allPayments : allPayments.filter(p => p.status === filter)

  if (!isConnected) {
    return <div className="flex items-center justify-center py-24 text-[var(--muted)]">Connect wallet to view payments</div>
  }

  const pending = allPayments.filter(p => p.status === 'AWAITING_APPROVAL')
  const authorized = allPayments.filter(p => p.status === 'AUTHORIZED')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="display text-2xl font-700 text-[var(--ink)] tracking-tight">Payments</h1>
        <p className="text-sm text-[var(--muted)] mt-1">Review, approve, and track USDC payments</p>
      </div>

      {/* Pending approvals */}
      {pending.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5">
          <h2 className="font-600 text-amber-800 mb-3 flex items-center gap-2">
            <CheckCircle size={16} /> {pending.length} payment{pending.length > 1 ? 's' : ''} awaiting your approval
          </h2>
          <div className="space-y-3">
            {pending.map(p => (
              <ApprovalCard key={p.id} payment={p}
                onApprove={() => approve.mutate(p.id)}
                onReject={() => reject.mutate(p.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Authorized payments ready to execute */}
      {authorized.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5">
          <h2 className="font-600 text-blue-800 mb-3 flex items-center gap-2">
            <CreditCard size={16} /> {authorized.length} payment{authorized.length > 1 ? 's' : ''} authorized — ready to execute
          </h2>
          <div className="space-y-3">
            {authorized.map(p => (
              <ExecuteCard key={p.id} payment={p} walletAddress={address!} />
            ))}
          </div>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {(['all','AWAITING_APPROVAL','AUTHORIZED','SUBMITTED','CONFIRMED','FAILED','REJECTED'] as FilterStatus[]).map(s => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
              filter === s
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--surface-muted)] text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
          >
            {s === 'all' ? 'All' : s.replace(/_/g, ' ')}
            {s !== 'all' && (
              <span className="ml-1.5 opacity-70">
                {allPayments.filter(p => p.status === s).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Payment list */}
      {payments.length === 0 ? (
        <div className="text-center py-16 text-[var(--muted)]">
          <CreditCard size={40} className="mx-auto mb-3 opacity-30" />
          <p className="font-medium">No payments found</p>
          <p className="text-sm mt-1">Payments appear here when agents request them</p>
        </div>
      ) : (
        <div className="space-y-2">
          {payments.map(p => (
            <PaymentRow key={p.id} payment={p} />
          ))}
        </div>
      )}
    </div>
  )
}

function PolicyChecks({ pr }: { pr: PolicyResult }) {
  return (
    <div className="mt-2 space-y-1">
      {pr.checks.map(c => (
        <div key={c.rule} className="flex items-center gap-2 text-xs">
          {c.passed
            ? <CheckCircle size={12} className="text-green-500 flex-shrink-0" />
            : <XCircle size={12} className="text-red-500 flex-shrink-0" />}
          <span className={c.passed ? 'text-[var(--muted)]' : 'text-red-600'}>{c.detail}</span>
        </div>
      ))}
    </div>
  )
}

function ApprovalCard({ payment, onApprove, onReject }: { payment: Payment; onApprove: () => void; onReject: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const pr = parsePolicyResult(payment.policy_result)

  return (
    <div className="bg-white rounded-xl border border-amber-200 p-4">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-600 text-[var(--ink)] tabular-nums">${formatUsdc(payment.amount_usdc)} USDC</span>
            <span className="text-[var(--muted)]">→</span>
            <code className="mono text-xs text-[var(--ink)]">{formatAddress(payment.recipient)}</code>
          </div>
          <p className="text-xs text-[var(--muted)] mt-0.5">Purpose: {payment.purpose} · {relativeTime(payment.created_at)}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={onReject} className="px-3 py-1.5 rounded-lg border border-red-200 text-xs font-600 text-red-600 hover:bg-red-50 transition-colors flex items-center gap-1">
            <XCircle size={12} /> Reject
          </button>
          <button onClick={onApprove} className="px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-xs font-600 hover:bg-[var(--accent-hover)] transition-colors flex items-center gap-1">
            <CheckCircle size={12} /> Approve
          </button>
        </div>
      </div>
      {pr && (
        <button onClick={() => setExpanded(!expanded)} className="mt-2 text-xs text-[var(--muted)] flex items-center gap-1 hover:text-[var(--ink)]">
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {pr.checks.length} policy checks passed
        </button>
      )}
      {expanded && pr && <PolicyChecks pr={pr} />}
    </div>
  )
}

function ExecuteCard({ payment, walletAddress }: { payment: Payment; walletAddress: string }) {
  const qc = useQueryClient()
  const usdcFact = getUsdc(ARC_CHAIN_ID)
  const { writeContract, data: hash, isPending, error } = useWriteContract()
  const { isLoading: isConfirming, isSuccess, data: receipt } = useWaitForTransactionReceipt({ hash })

  // Update backend state when tx confirmed
  if (isSuccess && receipt && payment.status === 'SUBMITTED') {
    void api.confirmPayment(payment.id, Number(receipt.blockNumber), payment.amount_usdc)
      .then(() => qc.invalidateQueries({ queryKey: ['payments'] }))
  }

  function execute() {
    if (!usdcFact) { toast.error('USDC not found on this chain'); return }
    if (payment.status !== 'AUTHORIZED') { toast.error('Payment is not authorized'); return }
    try {
      const amount = parseAmount(ARC_CHAIN_ID, payment.amount_usdc)
      writeContract({
        address: usdcFact.address as `0x${string}`,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [payment.recipient as `0x${string}`, amount.raw],
        chainId: ARC_CHAIN_ID,
      })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // When hash is available but backend not yet updated
  if (hash && payment.status === 'AUTHORIZED') {
    void api.submitPayment(payment.id, hash)
      .then(() => qc.invalidateQueries({ queryKey: ['payments'] }))
  }

  return (
    <div className="bg-white rounded-xl border border-blue-200 p-4">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-600 text-[var(--ink)] tabular-nums">${formatUsdc(payment.amount_usdc)} USDC</span>
            <span className="text-[var(--muted)]">→</span>
            <code className="mono text-xs text-[var(--ink)]">{formatAddress(payment.recipient)}</code>
          </div>
          <p className="text-xs text-[var(--muted)] mt-0.5">From: {formatAddress(walletAddress)}</p>
          {isConfirming && <p className="text-xs text-blue-600 mt-1">Waiting for confirmation…</p>}
          {isSuccess && <p className="text-xs text-green-600 mt-1 flex items-center gap-1"><CheckCircle size={11} /> Confirmed on block {receipt?.blockNumber?.toString()}</p>}
          {error && <p className="text-xs text-red-600 mt-1">{error.message}</p>}
        </div>
        {!isSuccess && (
          <button onClick={execute} disabled={isPending || isConfirming}
            className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-600 hover:bg-blue-700 transition-colors disabled:opacity-60 flex items-center gap-1">
            {isPending ? 'Confirm in wallet…' : isConfirming ? 'Confirming…' : 'Execute Transfer'}
          </button>
        )}
        {isSuccess && hash && (
          <a href={buildTxExplorerUrl(ARC_CHAIN_ID, hash)} target="_blank" rel="noopener noreferrer"
            className="px-3 py-1.5 rounded-lg border border-green-200 text-xs font-600 text-green-700 hover:bg-green-50 transition-colors flex items-center gap-1">
            <ExternalLink size={12} /> View Tx
          </a>
        )}
      </div>
    </div>
  )
}

function PaymentRow({ payment }: { payment: Payment }) {
  const [expanded, setExpanded] = useState(false)
  const pr = parsePolicyResult(payment.policy_result)

  return (
    <div className="bg-white/80 backdrop-blur rounded-xl border border-[var(--border)] p-4">
      <div className="flex items-center gap-3">
        <StatusBadge status={payment.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-600 text-sm tabular-nums">${formatUsdc(payment.amount_usdc)}</span>
            <span className="text-[var(--muted)] text-sm">→</span>
            <code className="mono text-xs text-[var(--ink)]">{formatAddress(payment.recipient)}</code>
          </div>
          <p className="text-xs text-[var(--subtle)]">{payment.purpose} · {relativeTime(payment.created_at)}</p>
        </div>
        {payment.tx_hash && (
          <a href={buildTxExplorerUrl(ARC_CHAIN_ID, payment.tx_hash)} target="_blank" rel="noopener noreferrer"
            className="text-[var(--muted)] hover:text-[var(--accent)] transition-colors p-1">
            <ExternalLink size={14} />
          </a>
        )}
        {(payment.error_message || pr) && (
          <button onClick={() => setExpanded(!expanded)} className="text-[var(--muted)] hover:text-[var(--ink)] p-1 transition-colors">
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        )}
      </div>
      {expanded && (
        <div className="mt-3 pt-3 border-t border-[var(--border)] space-y-2">
          {payment.error_message && (
            <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{payment.error_message}</p>
          )}
          {payment.tx_hash && (
            <p className="text-xs text-[var(--muted)]">Tx: <code className="mono">{payment.tx_hash}</code></p>
          )}
          {pr && <PolicyChecks pr={pr} />}
        </div>
      )}
    </div>
  )
}
