/**
 * Circle Developer-Controlled Wallets (DCW) service — Sprint 3.
 *
 * ARCHITECTURE DESIGN DECISION (documented per Sprint 3 requirement):
 * ─────────────────────────────────────────────────────────────────────
 * Two designs were considered:
 *
 *  Option A: Per-agent dedicated EOA wallet (chosen)
 *    - Each agent gets its own Circle DCW EOA wallet on ARC-TESTNET.
 *    - The wallet is funded by the user with a specific USDC budget (matching
 *      the agent's budget_usdc setting).
 *    - The server signs and submits USDC transfers from the agent's wallet
 *      directly — no MetaMask popup, no browser interaction required.
 *    - Revocation: the server simply stops accepting payment requests for the
 *      agent; no on-chain mechanism needed for the MVP.
 *    - Spending ceiling: enforced by the backend policy engine BEFORE every
 *      createTransaction call. This is a backend-only enforcement — it is NOT
 *      enforced on-chain. The limitation is documented in docs/security-review.md.
 *    - Key management: Circle manages the private key material via the entity
 *      secret / HSM model. The entity secret is server-side only, never exposed
 *      to the frontend or to the AI agent.
 *
 *  Option B: Smart contract wallet with on-chain spending limits
 *    - Would deploy a custom Solidity contract (e.g. an ERC-4337 SCA or a
 *      simple allowance contract) that enforces per-tx and total limits on-chain.
 *    - Advantages: limits are enforceable even if the backend is compromised.
 *    - Disadvantages for MVP: requires audited contract code, more gas overhead,
 *      more complex deployment, and still relies on the backend to NOT call
 *      executeApproval outside limits.
 *    - Decision: deferred to a future release. The per-agent EOA wallet provides
 *      a hard practical ceiling via wallet funding — an agent wallet can only
 *      spend what was deposited into it.
 *
 * SECURITY PROPERTIES (what is enforced and where):
 * ─────────────────────────────────────────────────
 *  ✓ Agents never receive private keys or signing credentials.
 *  ✓ The entity secret is loaded from CIRCLE_ENTITY_SECRET env var (server-only).
 *  ✓ The CIRCLE_API_KEY is loaded from CIRCLE_API_KEY env var (server-only).
 *  ✓ Budget/policy checks run atomically BEFORE createTransaction.
 *  ✓ Idempotency keys prevent duplicate Circle transactions on retry.
 *  ✓ Reservation system prevents concurrent requests from overspending.
 *  ✓ Revocation immediately blocks new payment requests (policy check).
 *  ✓ Circle transaction ID is stored for audit reconciliation.
 *  ⚠ Spending limits are backend-enforced only, not on-chain. A compromised
 *    server could bypass them. Documented limitation for this MVP.
 *  ⚠ Wallet funding is a manual user action — AgentPay does not auto-fund.
 */
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets'
import { v4 as uuid } from 'uuid'

// ─── Circle SDK client (lazy-initialized) ────────────────────────────────────

let _client: ReturnType<typeof initiateDeveloperControlledWalletsClient> | null = null

function getClient() {
  if (_client) return _client
  const apiKey       = process.env.CIRCLE_API_KEY
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET ?? process.env.ENTITY_SECRET
  if (!apiKey || !entitySecret) {
    throw new DcwNotConfiguredError(
      'CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET must be set for autonomous payment execution. ' +
      'See docs/sprint3-setup.md for setup instructions.'
    )
  }
  _client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret })
  return _client
}

export class DcwNotConfiguredError extends Error {
  constructor(msg: string) { super(msg); this.name = 'DcwNotConfiguredError' }
}

export function isDcwConfigured(): boolean {
  return !!(process.env.CIRCLE_API_KEY && (process.env.CIRCLE_ENTITY_SECRET ?? process.env.ENTITY_SECRET))
}

// ─── Constants (from onchain-facts.ts — imported at runtime) ─────────────────
// Arc Testnet USDC ERC-20 address (from src/onchain-facts.ts).
export const ARC_TESTNET_USDC  = '0x3600000000000000000000000000000000000000'
export const ARC_TESTNET_CHAIN = 'ARC-TESTNET'
export const ARC_TESTNET_EXPLORER = 'https://explorer.testnet.arc.io'

// ─── Wallet provisioning ─────────────────────────────────────────────────────

export interface ProvisionResult {
  walletId:      string
  walletAddress: string
  walletSetId:   string
}

/**
 * Provision a new dedicated EOA wallet for an agent.
 * Creates a wallet set named after the agent, then creates one EOA wallet in it.
 * Called once per agent when autonomous execution is first enabled.
 */
export async function provisionAgentWallet(agentId: string, agentName: string): Promise<ProvisionResult> {
  const client = getClient()

  // Create a dedicated wallet set for this agent so future wallets can be added.
  const wsRes = await client.createWalletSet({
    name: `AgentPay-${agentName}-${agentId.slice(0, 8)}`,
    idempotencyKey: uuid(),
  })
  const walletSetId = wsRes.data?.walletSet?.id
  if (!walletSetId) throw new Error('Circle DCW: failed to create wallet set')

  // Create one EOA wallet on ARC-TESTNET.
  // EOA is the right choice here: on Arc, USDC is the gas token, so no separate ETH needed.
  const walletRes = await client.createWallets({
    blockchains: [ARC_TESTNET_CHAIN],
    accountType: 'EOA',
    count: 1,
    walletSetId,
    idempotencyKey: uuid(),
  })
  const wallet = walletRes.data?.wallets?.[0]
  if (!wallet?.id || !wallet.address) throw new Error('Circle DCW: failed to create wallet')

  return {
    walletId:      wallet.id,
    walletAddress: wallet.address,
    walletSetId,
  }
}

// ─── Balance check ────────────────────────────────────────────────────────────

export interface WalletBalance {
  usdc: string        // formatted USDC balance string
  walletAddress: string
}

/**
 * Fetch the USDC balance of an agent's DCW wallet.
 * Never call getWallet/listWallets for balances — use getWalletTokenBalance.
 */
export async function getAgentWalletBalance(walletId: string): Promise<WalletBalance | null> {
  const client = getClient()
  try {
    const res = await client.getWalletTokenBalance({ id: walletId })
    const balances = res.data?.tokenBalances ?? []
    const usdcEntry = balances.find(b =>
      b.token?.address?.toLowerCase() === ARC_TESTNET_USDC.toLowerCase() ||
      b.token?.symbol === 'USDC'
    )
    return {
      usdc: usdcEntry?.amount ?? '0',
      walletAddress: '', // caller has this already
    }
  } catch {
    return null
  }
}

// ─── Transaction execution ────────────────────────────────────────────────────

export interface ExecutePaymentResult {
  circleTxId: string
  status:     'submitted' | 'failed'
  error?:     string
}

/**
 * Execute an autonomous USDC transfer from the agent's DCW wallet.
 *
 * Security contract:
 *  - This function is ONLY called after the policy engine has authorized the payment.
 *  - The amount comes from the DB payment row (trusted), never from the caller.
 *  - The idempotency key prevents duplicate submissions on retry.
 *  - Returns the Circle transaction ID for polling and audit.
 */
export async function executeAgentPayment(opts: {
  walletId:       string
  recipientAddress: string
  amountUsdc:     string   // e.g. "0.05"
  paymentId:      string   // used as idempotency key prefix
}): Promise<ExecutePaymentResult> {
  const client = getClient()

  // The idempotency key scopes this Circle transaction to this exact payment.
  // If we crash and retry, Circle will return the same transaction instead of
  // creating a duplicate transfer.
  const idempotencyKey = `agentpay-${opts.paymentId}`

  try {
    const res = await client.createTransaction({
      walletId:           opts.walletId,
      tokenAddress:       ARC_TESTNET_USDC,
      destinationAddress: opts.recipientAddress,
      amounts:            [opts.amountUsdc],
      fee: {
        type:   'level',
        config: { feeLevel: 'MEDIUM' },
      },
      idempotencyKey,
    })

    const txId = res.data?.id
    if (!txId) throw new Error('Circle DCW: no transaction ID in response')

    return { circleTxId: txId, status: 'submitted' }
  } catch (err) {
    const msg = (err as Error).message ?? 'Unknown DCW error'
    return { circleTxId: '', status: 'failed', error: msg }
  }
}

// ─── Transaction status polling ───────────────────────────────────────────────

export interface TxPollResult {
  state:   string
  txHash:  string | null
  error?:  string
}

/** Terminal states per Circle DCW documentation. */
export const CIRCLE_TERMINAL_STATES = new Set(['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED'])

/**
 * Poll a Circle transaction until it reaches a terminal state.
 * On Arc, instant finality means SENT → COMPLETE without a CONFIRMED step.
 * Uses `@/onchain-wait` semantics: poll with bounded back-off, give up after
 * maxAttempts, return the last known state.
 */
export async function pollCircleTransaction(
  circleTxId: string,
  maxAttempts = 60,
  intervalMs  = 3000,
): Promise<TxPollResult> {
  const client = getClient()
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs))
    try {
      const res = await client.getTransaction({ id: circleTxId })
      const tx  = res.data?.transaction
      if (!tx) continue
      if (CIRCLE_TERMINAL_STATES.has(tx.state ?? '')) {
        return {
          state:  tx.state ?? 'UNKNOWN',
          txHash: tx.txHash ?? null,
        }
      }
    } catch { /* transient error — keep polling */ }
  }
  return { state: 'TIMEOUT', txHash: null, error: 'Polling timed out after max attempts' }
}
