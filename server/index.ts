/**
 * AgentPay API server — security-hardened.
 *
 * Sprint 1 fixes applied here:
 *   CRITICAL-2: SIWE + JWT auth routes (/api/auth/nonce, /api/auth/verify)
 *   HIGH-3:     Explicit CORS origin allowlist (no more origin: true)
 */
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import agentsRouter   from './routes/agents.ts'
import paymentsRouter from './routes/payments.ts'
import db             from './db.ts'
import { issueNonce, verifySiweAndIssueJwt, requireOwnerJwt, verifyOwnerJwt } from './auth.ts'

const app  = express()
const PORT = parseInt(process.env.PORT ?? '3001', 10)

// ─── HIGH-3: CORS explicit allowlist ─────────────────────────────────────────
// 'origin: true' (mirror-all) was replaced with an explicit allowlist.
// Requests from unlisted origins receive no CORS headers and no access.
const ALLOWED_ORIGINS: string[] = [
  // Local development
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  // Arc Studio preview (injected at startup via env var, optional)
  ...(process.env.ALLOWED_ORIGIN ? [process.env.ALLOWED_ORIGIN] : []),
  // Production deployment origin (set via env var)
  ...(process.env.PRODUCTION_ORIGIN ? [process.env.PRODUCTION_ORIGIN] : []),
]

app.use(helmet({
  // CSP is managed by the frontend Vite server; disable here for the API.
  contentSecurityPolicy: false,
}))

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no Origin header (server-to-server, curl, test scripts).
    if (!origin) { cb(null, true); return }
    if (ALLOWED_ORIGINS.includes(origin)) { cb(null, true); return }
    cb(new Error(`CORS: origin ${origin} not allowed`))
  },
  methods:        ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials:    false,
}))

app.use(express.json({ limit: '64kb' }))
app.set('trust proxy', 1)

// ─── Rate limiters ────────────────────────────────────────────────────────────
// Limits are intentionally relaxed in test mode so the concurrent-request
// security tests (which fire 22+ rapid requests) are not throttled by the
// limiter before they can exercise the budget enforcement logic.
const IS_TEST          = process.env.NODE_ENV === 'test'
const agentLimiter     = rateLimit({ windowMs: 15 * 60 * 1000, max: IS_TEST ? 10_000 : 200,  standardHeaders: true, legacyHeaders: false })
const dashboardLimiter = rateLimit({ windowMs: 60 * 1000,      max: IS_TEST ? 10_000 : 120,  standardHeaders: true, legacyHeaders: false })
const authLimiter      = rateLimit({ windowMs: 60 * 1000,      max: IS_TEST ? 10_000 : 20,   standardHeaders: true, legacyHeaders: false })

// ─── CRITICAL-2: SIWE authentication routes ───────────────────────────────────

/** GET /api/auth/nonce — issue a single-use nonce for SIWE message construction. */
app.get('/api/auth/nonce', authLimiter, (_req, res) => {
  const nonce = issueNonce()
  res.json({ nonce })
})

/**
 * POST /api/auth/verify — verify a signed SIWE message and issue a JWT.
 * Body: { message: string (SIWE message text), signature: string (hex) }
 * Response: { token: string, address: string }
 */
app.post('/api/auth/verify', authLimiter, async (req, res) => {
  const result = await verifySiweAndIssueJwt(req.body as { message: string; signature: string })
  if (!result.ok) {
    res.status(401).json({ error: result.error }); return
  }
  res.json({ token: result.token, address: result.address })
})

/** GET /api/auth/me — return the authenticated owner's address (JWT probe).
 *  This route never accepts the X-Owner-Address fallback: it exists specifically
 *  to verify that JWT authentication is working correctly.
 */
app.get('/api/auth/me', authLimiter, async (req, res) => {
  // /api/auth/me never accepts the X-Owner-Address fallback — JWT required always.
  const header = req.headers['authorization'] ?? ''
  const match = header.match(/^Bearer (.+)$/)
  if (!match) { res.status(401).json({ error: 'Missing Authorization: Bearer <token>' }); return }
  const addr = await verifyOwnerJwt(match[1])
  if (!addr) { res.status(401).json({ error: 'Invalid or expired session token' }); return }
  res.json({ address: addr })
})

// ─── Domain routers ───────────────────────────────────────────────────────────
app.use('/api/agents',   dashboardLimiter, agentsRouter)
app.use('/api/payments', agentLimiter,     paymentsRouter)

// ─── Audit log ───────────────────────────────────────────────────────────────
app.get('/api/audit', dashboardLimiter, requireOwnerJwt, (req, res) => {
  const owner = (req as Record<string, unknown>).ownerAddress as string
  const { agent_id, limit = '100' } = req.query as Record<string, string>
  const lim = Math.min(500, Math.max(1, parseInt(limit) || 100))
  let query = `
    SELECT a.* FROM audit_logs a
    JOIN agents ag ON a.agent_id = ag.id
    WHERE ag.owner_address = ?
  `
  const params: unknown[] = [owner]
  if (agent_id) { query += ' AND a.agent_id = ?'; params.push(agent_id) }
  query += ' ORDER BY a.created_at DESC LIMIT ?'
  params.push(lim)
  res.json(db.query(query).all(...params))
})

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() })
})

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Don't leak CORS error details to clients
  if (err.message?.startsWith('CORS:')) {
    res.status(403).json({ error: 'Forbidden' }); return
  }
  console.error('[server]', err)
  res.status(500).json({ error: 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`[AgentPay API] listening on :${PORT}`)
  if (ALLOWED_ORIGINS.length > 0) {
    console.log(`[AgentPay API] CORS allowlist: ${ALLOWED_ORIGINS.join(', ')}`)
  }
})

export { app }  // exported for test harness
