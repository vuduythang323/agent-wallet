import { useState } from 'react'
import { Code2, Copy, Check, ExternalLink, Terminal } from 'lucide-react'
import { useAgents } from '@/hooks/useAgents'
import { useAccount } from 'wagmi'

export function DeveloperPage() {
  const { isConnected, address } = useAccount()
  const { data: agents = [] } = useAgents()
  const [copied, setCopied] = useState<string | null>(null)

  function copy(text: string, key: string) {
    void navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
  }

  const curlExample = `# Request a payment (from your AI agent)
curl -X POST https://your-app.com/api/payments/request \\
  -H "Authorization: Bearer YOUR_AGENT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "recipient": "0xRecipientAddress",
    "amount_usdc": "0.05",
    "purpose": "api",
    "idempotency_key": "req_abc123"
  }'`

  const tsClientExample = `/**
 * AgentPay TypeScript Client
 * Install: npm add agentpay-client  (or copy this inline)
 */
export class AgentPayClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = '/api',
  ) {}

  async requestPayment(params: {
    recipient: string
    amount_usdc: string
    purpose: string
    idempotency_key: string
  }) {
    const res = await fetch(\`\${this.baseUrl}/payments/request\`, {
      method: 'POST',
      headers: {
        'Authorization': \`Bearer \${this.apiKey}\`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error ?? 'Payment request failed')
    }
    return res.json()
  }
}

// Usage
const agent = new AgentPayClient(process.env.AGENTPAY_API_KEY!)

const result = await agent.requestPayment({
  recipient: '0xApiProvider...',
  amount_usdc: '0.05',
  purpose: 'data-api',
  idempotency_key: \`req_\${Date.now()}\`,
})

if (result.payment.status === 'CONFIRMED') {
  console.log('Payment confirmed! tx:', result.payment.tx_hash)
} else if (result.payment.status === 'AWAITING_APPROVAL') {
  console.log('Waiting for user approval...')
} else if (result.payment.status === 'REJECTED') {
  console.log('Rejected:', result.policy_result.rejection_reason)
}`

  const demoAgentExample = `/**
 * Demo Agent: calls a mock paid API using AgentPay
 * Run: bun run demo-agent.ts
 */
import { AgentPayClient } from './agentpay-client'

const agentpay = new AgentPayClient(
  process.env.AGENTPAY_API_KEY!,
  'http://localhost:3001',  // or your deployed URL
)

async function callPaidApi(query: string) {
  const key = \`req_\${query.replace(/\\W/g,'_').slice(0,20)}_\${Date.now()}\`

  console.log(\`[agent] requesting payment for query: "\${query}"\`)
  const { payment, policy_result } = await agentpay.requestPayment({
    recipient: '0xApiProvider...',  // replace with real provider
    amount_usdc: '0.05',
    purpose: 'api',
    idempotency_key: key,
  })

  if (payment.status === 'REJECTED') {
    throw new Error(\`Payment rejected: \${policy_result.rejection_reason}\`)
  }
  if (payment.status === 'AWAITING_APPROVAL') {
    console.log('[agent] payment needs human approval — poll for status change')
    return
  }
  // AUTHORIZED: user must execute transfer from dashboard
  console.log(\`[agent] payment \${payment.id} authorized — waiting for execution\`)
}

// Test: one permitted payment, one that exceeds budget
await callPaidApi('weather forecast nyc')
await callPaidApi('stock prices AAPL')  // will fail if budget exhausted`

  return (
    <div className="space-y-6">
      <div>
        <h1 className="display text-2xl font-700 text-[var(--ink)] tracking-tight">Developer</h1>
        <p className="text-sm text-[var(--muted)] mt-1">API documentation, credentials, and example code</p>
      </div>

      {/* Endpoint reference */}
      <div className="bg-white/80 backdrop-blur rounded-2xl border border-[var(--border)] p-5">
        <h2 className="font-600 text-[var(--ink)] mb-4 flex items-center gap-2"><Terminal size={16} /> API Endpoints</h2>
        <div className="space-y-1">
          {[
            ['POST',  '/api/payments/request',      'Agent key',    'Submit a payment request'],
            ['POST',  '/api/payments/:id/approve',  'X-Owner-Addr', 'Approve a pending payment'],
            ['POST',  '/api/payments/:id/reject',   'X-Owner-Addr', 'Reject a pending payment'],
            ['GET',   '/api/payments',              'X-Owner-Addr', 'List all payments'],
            ['POST',  '/api/agents',                'X-Owner-Addr', 'Create a new agent'],
            ['GET',   '/api/agents',                'X-Owner-Addr', 'List all agents'],
            ['PATCH', '/api/agents/:id/policy',     'X-Owner-Addr', 'Update spending policy'],
            ['POST',  '/api/agents/:id/revoke',     'X-Owner-Addr', 'Revoke an agent'],
          ].map(([method, path, auth, desc]) => (
            <div key={path+method} className="flex items-center gap-3 py-2 border-b border-[var(--border)] last:border-0">
              <span className={`text-xs font-700 w-12 tabular-nums ${
                method === 'GET' ? 'text-green-700' : method === 'POST' ? 'text-blue-700' : 'text-amber-700'
              }`}>{method}</span>
              <code className="mono text-xs text-[var(--ink)] flex-1">{path}</code>
              <span className="text-xs text-[var(--subtle)] hidden md:block w-28">{auth}</span>
              <span className="text-xs text-[var(--muted)] hidden md:block">{desc}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-[var(--muted)] mt-3">
          Dashboard routes authenticate via <code className="mono">X-Owner-Address</code> (connected wallet).
          Agent routes authenticate via <code className="mono">Authorization: Bearer {'<api-key>'}</code>.
        </p>
      </div>

      {/* CURL example */}
      <CodeBlock title="cURL Example — Payment Request" code={curlExample} id="curl" copied={copied} onCopy={copy} />

      {/* TypeScript client */}
      <CodeBlock title="TypeScript Client" code={tsClientExample} id="ts-client" copied={copied} onCopy={copy} />

      {/* Demo agent */}
      <CodeBlock title="Demo Agent Script" code={demoAgentExample} id="demo-agent" copied={copied} onCopy={copy} />

      {/* Payment flow diagram */}
      <div className="bg-white/80 backdrop-blur rounded-2xl border border-[var(--border)] p-5">
        <h2 className="font-600 text-[var(--ink)] mb-4 flex items-center gap-2"><Code2 size={16} /> Payment State Machine</h2>
        <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
          {[
            ['REQUESTED', 'bg-slate-100 text-slate-700'],
            ['→', ''],
            ['POLICY_CHECK', 'bg-slate-100 text-slate-700'],
            ['→', ''],
            ['AWAITING_APPROVAL', 'bg-blue-100 text-blue-700'],
            ['or', 'text-[var(--subtle)]'],
            ['AUTHORIZED', 'bg-green-100 text-green-700'],
            ['→', ''],
            ['SUBMITTED', 'bg-amber-100 text-amber-700'],
            ['→', ''],
            ['CONFIRMED', 'bg-green-100 text-green-700'],
          ].map(([label, cls], i) => (
            label === '→' || label === 'or'
              ? <span key={i} className={cls || 'text-[var(--subtle)]'}>{label}</span>
              : <span key={i} className={`px-2 py-1 rounded-full ${cls}`}>{label}</span>
          ))}
        </div>
        <p className="text-xs text-[var(--muted)] mt-3">
          REJECTED and FAILED are terminal states reachable from any pre-confirmation state.
          Budget deduction only occurs on CONFIRMED, never on SUBMITTED.
        </p>
      </div>

      {/* Architecture notes */}
      <div className="bg-white/80 backdrop-blur rounded-2xl border border-[var(--border)] p-5">
        <h2 className="font-600 text-[var(--ink)] mb-3">Architecture Notes</h2>
        <div className="space-y-2 text-sm text-[var(--ink-2)]">
          <p>
            <strong>Key custody model:</strong> AgentPay never holds private keys. The user's connected wallet signs USDC transfers.
            The backend validates policy and tracks state, but cannot unilaterally move funds.
          </p>
          <p>
            <strong>Idempotency:</strong> Every payment request must include a unique <code className="mono text-xs">idempotency_key</code>.
            Duplicate requests return the original payment object without re-executing.
          </p>
          <p>
            <strong>Concurrency safety:</strong> Budget deductions are wrapped in SQLite transactions.
            Two concurrent requests for the same agent cannot both pass if the combined amount exceeds the budget.
          </p>
          <p>
            <strong>MVP limitation:</strong> The dashboard wallet signs transfers directly. A production deployment
            would use a smart-contract wallet (ERC-4337) or a dedicated hot-wallet managed by a secure backend to eliminate
            manual approval for small, pre-authorized amounts.
          </p>
        </div>
        <a
          href="https://docs.arc.io"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center gap-1 text-sm text-[var(--accent)] hover:text-[var(--accent-hover)] font-medium"
        >
          Arc Testnet docs <ExternalLink size={12} />
        </a>
      </div>

      {isConnected && (
        <div className="bg-[var(--surface-muted)] rounded-2xl border border-[var(--border)] p-5">
          <h2 className="font-600 text-[var(--ink)] mb-2">Your Session</h2>
          <div className="space-y-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-[var(--muted)]">Connected wallet:</span>
              <code className="mono text-[var(--ink)]">{address}</code>
              <button onClick={() => copy(address!, 'wallet')} className="text-[var(--muted)] hover:text-[var(--accent)] transition-colors">
                {copied === 'wallet' ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
              </button>
            </div>
            <p className="text-[var(--muted)]">Agents: {agents.length} · Active: {agents.filter(a => a.status === 'active').length}</p>
          </div>
        </div>
      )}
    </div>
  )
}

function CodeBlock({ title, code, id, copied, onCopy }: {
  title: string; code: string; id: string; copied: string | null; onCopy: (t: string, k: string) => void
}) {
  return (
    <div className="bg-[var(--ink)] rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <span className="text-sm font-600 text-white/80">{title}</span>
        <button onClick={() => onCopy(code, id)} className="flex items-center gap-1.5 text-xs text-white/60 hover:text-white transition-colors">
          {copied === id ? <><Check size={12} className="text-green-400" /> Copied</> : <><Copy size={12} /> Copy</>}
        </button>
      </div>
      <pre className="mono text-xs text-slate-300 p-4 overflow-x-auto leading-relaxed">{code}</pre>
    </div>
  )
}
