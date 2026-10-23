/**
 * SQLite database via bun:sqlite (built-in, no native compilation).
 * WAL mode for crash safety across sandbox pause/resume.
 * Single-process — only this server file opens the database.
 */
import { Database } from 'bun:sqlite'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Allow tests to inject a custom DB path to avoid clobbering the dev DB.
const DB_PATH = process.env.AGENTPAY_DB_PATH ?? path.join(__dirname, '../agentpay.db')

export const db = new Database(DB_PATH, { create: true })

// Crash-safe settings (per docker skill guidance for SQLite)
db.run('PRAGMA journal_mode = WAL')
db.run('PRAGMA synchronous = FULL')
db.run('PRAGMA busy_timeout = 5000')
db.run('PRAGMA foreign_keys = ON')

// ─── Schema ────────────────────────────────────────────────────────────────

db.run(`
  CREATE TABLE IF NOT EXISTS agents (
    id                          TEXT PRIMARY KEY,
    owner_address               TEXT NOT NULL,
    name                        TEXT NOT NULL,
    description                 TEXT NOT NULL DEFAULT '',
    status                      TEXT NOT NULL DEFAULT 'active',
    api_key_hash                TEXT NOT NULL,
    budget_usdc                 TEXT NOT NULL DEFAULT '10',
    spent_usdc                  TEXT NOT NULL DEFAULT '0',
    -- CRITICAL-1 FIX: reserved_usdc tracks in-flight (authorized but unconfirmed) payments.
    -- Enforcement: spent_usdc + reserved_usdc + requested <= budget_usdc at reservation time.
    reserved_usdc               TEXT NOT NULL DEFAULT '0',
    max_per_tx_usdc             TEXT NOT NULL DEFAULT '1',
    daily_limit_usdc            TEXT NOT NULL DEFAULT '5',
    monthly_limit_usdc          TEXT NOT NULL DEFAULT '50',
    daily_spent_usdc            TEXT NOT NULL DEFAULT '0',
    monthly_spent_usdc          TEXT NOT NULL DEFAULT '0',
    daily_reset_at              TEXT NOT NULL DEFAULT (datetime('now', '+1 day')),
    monthly_reset_at            TEXT NOT NULL DEFAULT (datetime('now', '+30 days')),
    allowed_recipients          TEXT NOT NULL DEFAULT '[]',
    allowed_purposes            TEXT NOT NULL DEFAULT '[]',
    require_approval_above_usdc TEXT NOT NULL DEFAULT '999999',
    -- Sprint 3: autonomous execution via Circle developer-controlled wallets.
    -- circle_wallet_id is the DCW wallet ID for this agent; NULL until provisioned.
    -- circle_wallet_address is the EVM address of that wallet (for display + funding).
    -- circle_wallet_set_id is the wallet set the wallet belongs to.
    circle_wallet_id            TEXT,
    circle_wallet_address       TEXT,
    circle_wallet_set_id        TEXT,
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

// Migration: add reserved_usdc column to existing databases that predate this field.
// ALTER TABLE IF NOT EXISTS COLUMN is not supported in SQLite; use the PRAGMA approach.
const agentCols = db.query("PRAGMA table_info(agents)").all() as Array<{ name: string }>
if (!agentCols.some(c => c.name === 'reserved_usdc')) {
  db.run("ALTER TABLE agents ADD COLUMN reserved_usdc TEXT NOT NULL DEFAULT '0'")
}
// Sprint 3 migrations: DCW wallet columns.
if (!agentCols.some(c => c.name === 'circle_wallet_id')) {
  db.run('ALTER TABLE agents ADD COLUMN circle_wallet_id TEXT')
}
if (!agentCols.some(c => c.name === 'circle_wallet_address')) {
  db.run('ALTER TABLE agents ADD COLUMN circle_wallet_address TEXT')
}
if (!agentCols.some(c => c.name === 'circle_wallet_set_id')) {
  db.run('ALTER TABLE agents ADD COLUMN circle_wallet_set_id TEXT')
}

db.run(`
  CREATE TABLE IF NOT EXISTS payments (
    id                TEXT PRIMARY KEY,
    agent_id          TEXT NOT NULL REFERENCES agents(id),
    owner_address     TEXT NOT NULL,
    recipient         TEXT NOT NULL,
    amount_usdc       TEXT NOT NULL,
    purpose           TEXT NOT NULL DEFAULT '',
    idempotency_key   TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'REQUESTED',
    policy_result     TEXT,
    tx_hash           TEXT,
    block_number      INTEGER,
    error_message     TEXT,
    -- Sprint 3: Circle DCW transaction ID for autonomous execution tracking.
    circle_tx_id      TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    -- HIGH-2 FIX: scope idempotency key to the owning agent, not globally.
    -- A different agent with the same key is a separate payment, not a replay.
    UNIQUE(agent_id, idempotency_key)
  )
`)

// Migration: drop the old global unique constraint and add the scoped one.
// SQLite cannot drop constraints; detect via index name and recreate if needed.
const payIdxNames = (db.query("PRAGMA index_list(payments)").all() as Array<{ name: string }>).map(r => r.name)
if (payIdxNames.some(n => n.toLowerCase().includes('idempotency_key') && !n.toLowerCase().includes('agent'))) {
  // Old global constraint exists — rebuild the table to replace the constraint.
  db.transaction(() => {
    db.run('ALTER TABLE payments RENAME TO payments_old')
    db.run(`
      CREATE TABLE payments (
        id                TEXT PRIMARY KEY,
        agent_id          TEXT NOT NULL REFERENCES agents(id),
        owner_address     TEXT NOT NULL,
        recipient         TEXT NOT NULL,
        amount_usdc       TEXT NOT NULL,
        purpose           TEXT NOT NULL DEFAULT '',
        idempotency_key   TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'REQUESTED',
        policy_result     TEXT,
        tx_hash           TEXT,
        block_number      INTEGER,
        error_message     TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(agent_id, idempotency_key)
      )
    `)
    db.run('INSERT OR IGNORE INTO payments SELECT * FROM payments_old')
    db.run('DROP TABLE payments_old')
  })()
}

// Sprint 3: add circle_tx_id column to existing payments tables.
const payCols = db.query("PRAGMA table_info(payments)").all() as Array<{ name: string }>
if (!payCols.some(c => c.name === 'circle_tx_id')) {
  db.run('ALTER TABLE payments ADD COLUMN circle_tx_id TEXT')
}

// CRITICAL-2: SIWE nonce store — single-use, short-lived.
db.run(`
  CREATE TABLE IF NOT EXISTS siwe_nonces (
    nonce      TEXT PRIMARY KEY,
    address    TEXT,          -- null until the nonce is consumed
    issued_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
  )
`)
// Clean up expired nonces every 5 minutes.
setInterval(() => {
  try { db.run("DELETE FROM siwe_nonces WHERE expires_at < datetime('now')") } catch { /* ignore */ }
}, 5 * 60_000)

db.run(`CREATE INDEX IF NOT EXISTS idx_payments_agent_id ON payments(agent_id)`)
db.run(`CREATE INDEX IF NOT EXISTS idx_payments_owner    ON payments(owner_address)`)
db.run(`CREATE INDEX IF NOT EXISTS idx_agents_owner      ON agents(owner_address)`)

db.run(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id         TEXT PRIMARY KEY,
    agent_id   TEXT,
    payment_id TEXT,
    actor      TEXT NOT NULL DEFAULT 'system',
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '',
    ip         TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

db.run(`CREATE INDEX IF NOT EXISTS idx_audit_agent   ON audit_logs(agent_id)`)
db.run(`CREATE INDEX IF NOT EXISTS idx_audit_payment ON audit_logs(payment_id)`)

// Periodic WAL checkpoint when idle
setInterval(() => {
  try { db.run('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* ignore */ }
}, 60_000)

export default db
