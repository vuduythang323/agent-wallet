import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export function formatUsdc(amount: string | number): string {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount
  if (isNaN(n)) return '0.00'
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
}

export function statusColor(status: string): string {
  switch (status) {
    case 'active':
    case 'CONFIRMED':
    case 'AUTHORIZED':
      return 'text-green-700 bg-green-50 border-green-200'
    case 'paused':
    case 'REQUESTED':
    case 'POLICY_CHECK':
    case 'SUBMITTED':
      return 'text-amber-700 bg-amber-50 border-amber-200'
    case 'AWAITING_APPROVAL':
      return 'text-blue-700 bg-blue-50 border-blue-200'
    case 'revoked':
    case 'FAILED':
    case 'REJECTED':
      return 'text-red-700 bg-red-50 border-red-200'
    default:
      return 'text-slate-600 bg-slate-50 border-slate-200'
  }
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return new Date(iso).toLocaleDateString()
}

export function budgetPct(spent: string, budget: string): number {
  const b = parseFloat(budget)
  if (!b) return 0
  return Math.min(100, (parseFloat(spent) / b) * 100)
}
