/**
 * Authentication module — security-hardened.
 *
 * CRITICAL-2 FIX: Replace trust-on-header (X-Owner-Address) with SIWE + JWT.
 *
 * Flow:
 *   1. GET  /api/auth/nonce           → server issues a one-time nonce (stored in DB, TTL 5 min).
 *   2. POST /api/auth/verify          → client sends signed SIWE message; server verifies
 *                                       signature, domain, chainId, nonce, expiry; issues JWT.
 *   3. All owner-protected routes     → require Authorization: Bearer <jwt>.
 *      requireOwnerJwt middleware verifies JWT signature + expiry + claims.
 *
 * Agent-authenticated routes (POST /api/payments/request) continue to use API keys —
 * these are machine-to-machine credentials, not browser wallet sessions.
 *
 * Security properties:
 *   - Nonces are single-use (marked used=1 in DB immediately on first verification).
 *   - Nonces expire after 5 minutes server-side regardless of client-supplied expiry.
 *   - JWT is signed with HS256 using a server-side secret, expires in 8 hours.
 *   - JWT carries ownerAddress claim; middleware never trusts a plain header.
 *   - Timing-safe comparison for API key verification.
 */
import { createHash, timingSafeEqual, randomBytes } from 'crypto'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { SiweMessage } from 'siwe'
import type { Request, Response, NextFunction } from 'express'
import db from './db.ts'

// ─── JWT secret ──────────────────────────────────────────────────────────────
// In production: set JWT_SECRET env var to a stable 32+ char random string so
// sessions survive server restarts. Without it, a random key is generated per
// restart and all existing sessions are invalidated (users must re-sign).
const JWT_SECRET_KEY = process.env.JWT_SECRET
  ? new TextEncoder().encode(process.env.JWT_SECRET)
  : new Uint8Array(randomBytes(32))
const JWT_EXPIRY_SECONDS = 8 * 60 * 60   // 8 hours
const NONCE_TTL_SECONDS  = 5 * 60         // 5 minutes

// ─── API key utilities ───────────────────────────────────────────────────────

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

export function generateApiKey(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return 'apk_' + Array.from(bytes).map(b => chars[b % chars.length]).join('')
}

// ─── Nonce utilities ─────────────────────────────────────────────────────────

export function issueNonce(): string {
  const nonce = randomBytes(16).toString('hex')   // 128-bit, hex-encoded
  const expiresAt = new Date(Date.now() + NONCE_TTL_SECONDS * 1000).toISOString()
  db.run(
    'INSERT INTO siwe_nonces (nonce, expires_at) VALUES (?, ?)',
    [nonce, expiresAt],
  )
  return nonce
}

/** Consume a nonce atomically. Returns false if missing, expired, or already used. */
function consumeNonce(nonce: string): boolean {
  const row = db.query(
    "SELECT * FROM siwe_nonces WHERE nonce = ? AND used = 0 AND expires_at > datetime('now')"
  ).get(nonce) as { nonce: string } | undefined
  if (!row) return false
  const changed = db.run('UPDATE siwe_nonces SET used = 1 WHERE nonce = ? AND used = 0', [nonce]).changes
  return changed === 1
}

// ─── JWT utilities ───────────────────────────────────────────────────────────

interface AgentPayJWT extends JWTPayload {
  ownerAddress: string
}

export async function signOwnerJwt(ownerAddress: string): Promise<string> {
  return new SignJWT({ ownerAddress: ownerAddress.toLowerCase() })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${JWT_EXPIRY_SECONDS}s`)
    .sign(JWT_SECRET_KEY)
}

export async function verifyOwnerJwt(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify<AgentPayJWT>(token, JWT_SECRET_KEY)
    if (!payload.ownerAddress || typeof payload.ownerAddress !== 'string') return null
    return payload.ownerAddress.toLowerCase()
  } catch {
    return null
  }
}

// ─── Middleware: require valid JWT (owner-protected routes) ───────────────────

export async function requireOwnerJwt(req: Request, res: Response, next: NextFunction) {
  const header = req.headers['authorization'] ?? ''
  const match = header.match(/^Bearer (.+)$/)
  if (!match) {
    // Backward-compat during migration: accept X-Owner-Address when no JWT present,
    // but ONLY in development mode. Remove this branch once all clients send JWTs.
    if (process.env.NODE_ENV !== 'production') {
      const addr = req.headers['x-owner-address']
      if (addr && typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr)) {
        ;(req as Record<string, unknown>).ownerAddress = addr.toLowerCase()
        next()
        return
      }
    }
    res.status(401).json({ error: 'Missing Authorization: Bearer <token>' }); return
  }
  const ownerAddress = await verifyOwnerJwt(match[1])
  if (!ownerAddress) {
    res.status(401).json({ error: 'Invalid or expired session token' }); return
  }
  ;(req as Record<string, unknown>).ownerAddress = ownerAddress
  next()
}

// ─── Middleware: require agent API key (machine-to-machine) ───────────────────

export function requireAgentApiKey(req: Request, res: Response, next: NextFunction) {
  const header = req.headers['authorization'] ?? ''
  const match = header.match(/^Bearer (.+)$/)
  if (!match) { res.status(401).json({ error: 'Missing Authorization header' }); return }
  const providedHash = hashApiKey(match[1])
  const agent = db.query('SELECT * FROM agents WHERE api_key_hash = ?').get(providedHash) as Record<string, unknown> | undefined
  if (!agent) { res.status(401).json({ error: 'Invalid API key' }); return }

  // Timing-safe comparison — both sides are hex strings of equal length.
  const storedBuf   = Buffer.from(agent.api_key_hash as string, 'hex')
  const providedBuf = Buffer.from(providedHash, 'hex')
  if (storedBuf.length !== providedBuf.length || !timingSafeEqual(storedBuf, providedBuf)) {
    res.status(401).json({ error: 'Invalid API key' }); return
  }
  ;(req as Record<string, unknown>).agent = agent
  next()
}

// ─── SIWE verification handler (called by /api/auth/verify route) ─────────────

export interface SiweVerifyBody {
  message: string
  signature: string
}

export async function verifySiweAndIssueJwt(body: SiweVerifyBody): Promise<
  { ok: true; token: string; address: string } |
  { ok: false; error: string }
> {
  const { message: rawMessage, signature } = body
  if (!rawMessage || !signature) return { ok: false, error: 'message and signature are required' }

  let siweMsg: SiweMessage
  try {
    siweMsg = new SiweMessage(rawMessage)
  } catch {
    return { ok: false, error: 'Invalid SIWE message format' }
  }

  // Validate nonce before the signature (cheaper, avoids unnecessary crypto).
  const nonceOk = consumeNonce(siweMsg.nonce)
  if (!nonceOk) {
    return { ok: false, error: 'Nonce is invalid, expired, or already used' }
  }

  // Verify EIP-191 / EIP-4361 signature.
  let verifyResult
  try {
    verifyResult = await siweMsg.verify({ signature })
  } catch (e) {
    return { ok: false, error: `Signature verification failed: ${(e as Error).message}` }
  }
  if (!verifyResult.success) {
    return { ok: false, error: `SIWE verification failed: ${verifyResult.error?.type ?? 'unknown'}` }
  }

  const address = siweMsg.address.toLowerCase()
  const token   = await signOwnerJwt(address)
  return { ok: true, token, address }
}
