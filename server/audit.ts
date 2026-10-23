import { v4 as uuid } from 'uuid'
import db from './db.ts'

interface AuditEntry {
  agent_id?: string | null
  payment_id?: string | null
  actor?: string
  action: string
  detail?: string
  ip?: string | null
}

export function auditLog(entry: AuditEntry) {
  try {
    db.run(
      'INSERT INTO audit_logs (id, agent_id, payment_id, actor, action, detail, ip) VALUES ($id, $agentId, $paymentId, $actor, $action, $detail, $ip)',
      {
        $id: uuid(),
        $agentId: entry.agent_id ?? null,
        $paymentId: entry.payment_id ?? null,
        $actor: entry.actor ?? 'system',
        $action: entry.action,
        $detail: entry.detail ?? '',
        $ip: entry.ip ?? null,
      },
    )
  } catch {
    console.error('[audit] failed to write audit log for action:', entry.action)
  }
}
