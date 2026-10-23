/**
 * Test helpers — create an in-memory server instance for each test suite.
 * Uses a separate :memory: SQLite DB so tests are fully isolated.
 */
import { Database } from 'bun:sqlite'
import express from 'express'
import cors from 'cors'
import { rateLimit } from 'express-rate-limit'
import { generateApiKey, hashApiKey, issueNonce, verifySiweAndIssueJwt, requireOwnerJwt } from '../auth.ts'
import agentsRouter   from '../routes/agents.ts'
import paymentsRouter from '../routes/payments.ts'
import { auditLog }   from '../audit.ts'

// ─── In-memory DB override ────────────────────────────────────────────────────
// Patch the db module before the routes are loaded.
// We do this by replacing the default export on the module-level singleton.
import { v4 as uuidv4 } from 'uuid'
import dbModule from '../db.ts'

export function createTestDb(): Database {
  const mem = new Database(':memory:')
  mem.run('PRAGMA journal_mode = WAL')
  mem.run('PRAGMA foreign_keys = ON')
  mem.run(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, owner_address TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
      api_key_hash TEXT NOT NULL,
      budget_usdc TEXT NOT NULL DEFAULT '10', spent_usdc TEXT NOT NULL DEFAULT '0',
      reserved_usdc TEXT NOT NULL DEFAULT '0',
      max_per_tx_usdc TEXT NOT NULL DEFAULT '1',
      daily_limit_usdc TEXT NOT NULL DEFAULT '5', monthly_limit_usdc TEXT NOT NULL DEFAULT '50',
      daily_spent_usdc TEXT NOT NULL DEFAULT '0', monthly_spent_usdc TEXT NOT NULL DEFAULT '0',
      daily_reset_at TEXT NOT NULL DEFAULT (datetime('now', '+1 day')),
      monthly_reset_at TEXT NOT NULL DEFAULT (datetime('now', '+30 days')),
      allowed_recipients TEXT NOT NULL DEFAULT '[]', allowed_purposes TEXT NOT NULL DEFAULT '[]',
      require_approval_above_usdc TEXT NOT NULL DEFAULT '999999',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  mem.run(`
    CREATE TABLE payments (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
      owner_address TEXT NOT NULL, recipient TEXT NOT NULL,
      amount_usdc TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'REQUESTED',
      policy_result TEXT, tx_hash TEXT, block_number INTEGER, error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(agent_id, idempotency_key)
    )
  `)
  mem.run(`
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, agent_id TEXT, payment_id TEXT,
      actor TEXT NOT NULL DEFAULT 'system', action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '', ip TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  mem.run(`
    CREATE TABLE siwe_nonces (
      nonce TEXT PRIMARY KEY, address TEXT,
      issued_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0
    )
  `)
  return mem
}

/** Seed a test agent and return plain-text API key + agent id. */
export function seedAgent(db: Database, opts: {
  owner: string
  budget?: string
  maxPerTx?: string
  daily?: string
  monthly?: string
  requireApprovalAbove?: string
}) {
  const id = uuidv4()
  const key = generateApiKey()
  const hash = hashApiKey(key)
  db.run(`
    INSERT INTO agents
      (id, owner_address, name, api_key_hash, budget_usdc, max_per_tx_usdc,
       daily_limit_usdc, monthly_limit_usdc, require_approval_above_usdc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id, opts.owner.toLowerCase(), 'TestAgent', hash,
    opts.budget ?? '1', opts.maxPerTx ?? '0.1',
    opts.daily ?? '0.5', opts.monthly ?? '5',
    opts.requireApprovalAbove ?? '999999',
  ])
  return { id, apiKey: key }
}
