import { cn, statusColor } from '@/lib/utils'

interface Props {
  status: string
  className?: string
}

const LABELS: Record<string, string> = {
  active: 'Active', paused: 'Paused', revoked: 'Revoked',
  REQUESTED: 'Requested', POLICY_CHECK: 'Checking', AWAITING_APPROVAL: 'Needs Approval',
  AUTHORIZED: 'Authorized', SUBMITTED: 'Submitted', CONFIRMED: 'Confirmed',
  FAILED: 'Failed', REJECTED: 'Rejected',
}

export function StatusBadge({ status, className }: Props) {
  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border',
      statusColor(status), className,
    )}>
      {LABELS[status] ?? status}
    </span>
  )
}
