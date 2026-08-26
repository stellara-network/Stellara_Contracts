# Stellara Smart Contracts - Detailed Documentation

## Contract Architecture

All contracts follow Soroban best practices and are optimized for the Testnet environment.

### Design Patterns

1. **Contract Initialization**: All contracts require explicit initialization before use
2. **Authentication**: Functions requiring authorization use `require_auth()` for security
3. **Data Storage**: Persistent state stored in contract instance storage
4. **Error Handling**: Using Symbol-based error codes for gas efficiency
5. **Fee Handling**: Standardized fee collection via `FeeManager`
6. **Cross-Contract Safety**: Atomic multi-contract operations via `safe_call`

## Cross-Contract Call Safety

The system implements a `CrossCall` module (`shared/src/safe_call.rs`) to ensure atomicity and proper error propagation when contracts call each other.

### Guarantees
1.  **Atomicity**: If a downstream contract call fails (panics or returns error), the upstream contract catches the error and propagates it, causing the entire transaction (including any prior state changes like fee payments) to roll back.
2.  **Defensive Checks**: The `safe_invoke` wrapper abstracts `env.try_invoke_contract`, ensuring that all cross-contract calls are handled safely.

### Usage
Use `shared::safe_call::safe_invoke` instead of raw `env.invoke_contract` when you need to handle potential failures gracefully or ensure explicit error codes are returned.

```rust
match safe_invoke(&env, &contract_id, &func_name, args) {
    Ok(val) => { /* success */ },
    Err(code) => { /* handle error or propagate */ }
}
```

## Fee Handling

All contracts implementing fee collection use the `FeeManager` from the shared library.

### Fee Collection Process
1. **Check Balance**: The contract verifies the payer has sufficient balance of the fee token.
2. **Collect Fee**: The fee is transferred from the payer to the designated fee recipient.
3. **Execute Operation**: If fee collection succeeds, the contract operation proceeds.

### Error Codes
- `InsufficientBalance` (1001): The payer does not have enough funds to cover the fee.
- `InvalidAmount` (1002): The fee amount is invalid (negative).

## Trading Contract

### Purpose
Enables decentralized exchange of cryptocurrency pairs with trade history tracking and risk-based controls.

### Risk-Based Controls

The trading contract implements a comprehensive risk management system that stratifies users by verified identity level and enforces position limits, liquidity checks, and circuit breakers per risk tier.

#### Risk Tiers

Users are classified into four risk tiers based on KYC verification status and account age:

| Tier | Name | KYC Level | Account Age | Position Limit | Daily Volume Cap | Max Slippage | Min Liquidity |
|------|------|-----------|--------------|----------------|------------------|--------------|---------------|
| 0 | Basic | None/Basic | < 30 days | 1,000,000 | 5,000,000 | 1% (100 bps) | 10,000,000 |
| 1 | Verified | Basic | ≥ 30 days | 5,000,000 | 25,000,000 | 2% (200 bps) | 5,000,000 |
| 2 | Enhanced | Enhanced | ≥ 90 days | 25,000,000 | 100,000,000 | 3% (300 bps) | 2,500,000 |
| 3 | Institutional | Institutional | Any | 100,000,000 | 500,000,000 | 5% (500 bps) | 1,000,000 |

**Tier Assignment Logic:**
- Institutional KYC → Institutional tier (regardless of account age)
- Enhanced KYC + 90+ days → Institutional tier
- Enhanced KYC + 30-89 days → Enhanced tier
- Basic KYC + 30+ days → Verified tier
- All other cases → Basic tier

#### Risk Checks

All trades and limit orders undergo the following risk checks before execution:

1. **Position Limit Check**: Ensures the new position size does not exceed the tier's maximum
2. **Daily Volume Check**: Ensures the trade doesn't exceed the daily volume cap (resets after 24h)
3. **Liquidity Check**: Ensures sufficient pool liquidity remains after the trade
4. **Circuit Breaker Check**: Pauses trading if price volatility exceeds tier-specific thresholds

#### Circuit Breaker

The tiered circuit breaker monitors price movements and triggers protective pauses:

| Tier | Volatility Threshold | Observation Window | Cooldown Period |
|------|---------------------|-------------------|-----------------|
| Basic | 0.5% (50 bps) | 5 minutes | 1 hour |
| Verified | 1% (100 bps) | 5 minutes | 1 hour |
| Enhanced | 2% (200 bps) | 5 minutes | 1 hour |
| Institutional | 5% (500 bps) | 5 minutes | 1 hour |

When triggered, trading is paused for all users in the affected tier until the cooldown period expires or an admin manually resets the circuit breaker.

#### Risk Metadata

Every trade and order includes comprehensive risk metadata for compliance auditing:

```rust
pub struct RiskMetadata {
    pub user_tier: RiskTier,
    pub position_limit: i128,
    pub volume_cap: i128,
    pub slippage_limit_bps: u32,
    pub liquidity_check_passed: bool,
    pub circuit_breaker_check_passed: bool,
}
```

#### Admin Functions

Administrators can manage risk controls through the following functions:

- `update_user_kyc(admin, user, kyc_level)`: Update a user's KYC level and recalculate tier
- `get_user_risk_profile(user)`: Retrieve a user's current risk profile
- `get_tier_config(tier)`: Get configuration for a specific tier
- `update_tier_config(admin, tier, config)`: Modify tier limits and thresholds
- `get_tiered_cb_state()`: Check circuit breaker status
- `reset_tiered_circuit_breaker(admin)`: Manually reset circuit breaker

#### Operator Monitoring Procedures

**Daily Monitoring:**
1. Review circuit breaker state for any triggered tiers
2. Check users approaching daily volume caps
3. Monitor large trades that significantly impact pool liquidity
4. Verify KYC level updates and tier transitions

**Weekly Monitoring:**
1. Analyze tier distribution and identify users eligible for upgrades
2. Review position limit utilization across all tiers
3. Assess circuit breaker trigger patterns and adjust thresholds if needed
4. Audit risk metadata for compliance reporting

**Alert Thresholds:**
- Circuit breaker triggered → Immediate notification
- User exceeds 80% of daily volume cap → Warning
- Trade depletes liquidity below 2x threshold → Warning
- Tier transition (upgrade/downgrade) → Informational

#### Integration with Identity Hub

The trading contract integrates with the Identity Hub contract for KYC verification:

1. Identity Hub stores KYC level and account creation timestamp
2. Trading contract queries Identity Hub to determine user's risk tier
3. KYC level updates in Identity Hub automatically trigger tier recalculation
4. Account age is calculated from hub creation timestamp

### State Variables
- `stats`: TradeStats - Global trading statistics
- `trades`: Vec<Trade> - Complete trade history
- `risk_profiles`: Map<Address, UserRiskProfile> - Per-user risk profiles
- `tier_configs`: Map<RiskTier, RiskTierConfig> - Tier-specific configurations
- `tiered_cb_state`: TieredCircuitBreakerState - Circuit breaker state

### Key Structs

```rust
pub struct Trade {
    pub id: u64,
    pub trader: Address,
    pub pair: Symbol,          // e.g., "USDT"
    pub amount: i128,          // Amount being traded
    pub price: i128,           // Price per unit
    pub timestamp: u64,        // Ledger timestamp
    pub is_buy: bool,          // Buy vs Sell order
    pub risk_metadata: RiskMetadata, // Risk compliance data
}

pub struct LimitOrder {
    pub id: u64,
    pub owner: Address,
    pub pair: Symbol,
    pub side: OrderSide,
    pub price: i128,
    pub amount: i128,
    pub remaining: i128,
    pub status: OrderStatus,
    pub tif: TimeInForce,
    pub timestamp: u64,
    pub risk_metadata: RiskMetadata, // Risk compliance data
}

pub struct UserRiskProfile {
    pub user: Address,
    pub tier: RiskTier,
    pub account_created_at: u64,
    pub kyc_level: Symbol,
    pub daily_volume_used: i128,
    pub daily_volume_window_start: u64,
    pub current_position_size: i128,
}

pub struct RiskTierConfig {
    pub max_position_size: i128,
    pub daily_volume_cap: i128,
    pub max_slippage_bps: u32,
    pub min_liquidity_threshold: i128,
    pub max_trade_size: i128,
}

pub struct TradeStats {
    pub total_trades: u64,
    pub total_volume: i128,
    pub last_trade_id: u64,
}

## Staking Rewards Contract

### Purpose
Allows users to stake tokens in different pools to earn rewards from protocol revenue.

### Pools
- **30 Days**: 5.00% APY
- **60 Days**: 10.00% APY
- **90 Days**: 15.00% APY

### Features
- **Early Withdrawal Penalty**: 10% deduction from principal if withdrawn before the lockup period ends.
- **Auto-compounding**: Users can re-stake their earned rewards into their principal.
- **Reward Claiming**: Separate function to withdraw rewards without affecting the stake.

### Key Structs

```rust
pub struct UserStake {
    pub amount: i128,              // Staked amount
    pub pool_id: u32,             // 0=30d, 1=60d, 2=90d
    pub start_timestamp: u64,      // Initial staking time
    pub last_claim_timestamp: u64, // Last time rewards were claimed
}

pub struct PoolConfig {
    pub lockup_seconds: u64,
    pub apy_bps: u32,              // APY in basis points (100 = 1%)
}
```

## Verifiable Credentials Contract (Soroban)

### Purpose
W3C-style verifiable credential issuance, verification, revocation, and reissuance with governance-controlled lifecycle.

### State Transitions

All state transitions are enforced by the contract and emit dedicated events:

```
  ┌─────────┐      issue_credential()      ┌─────────┐
  │         │ ──────────────────────────►  │  Valid   │
  │  (new)  │                              │          │
  └─────────┘                              └────┬─────┘
                                                │
                           ┌────────────────────┼────────────┐
                           │                    │            │
                    revoke_credential()   expires     reissue_credential()
                           │                    │            │
                     ┌─────▼──────┐       ┌─────▼─────┐  ┌──▼──────────────┐
                     │  Revoked   │       │  Expired   │  │ New Valid       │
                     │ (recorded) │       │ (emitted)  │  │ (old removed)   │
                     └────────────┘       └───────────┘  └─────────────────┘
                           │                    │            │
                           └────────────────────┴────────────┘
                                reissue_credential()
```

### Key Functions

| Function | Access | Description |
|---|---|---|
| `issue_credential(...)` | Authenticated | Issue a new credential with type, claims, and optional expiration |
| `verify_credential(id)` | Public | Returns `true` if credential is valid (not revoked, not expired, valid proof) |
| `revoke_credential(...)` | Authenticated | Revoke with reason + proof; records in audit trail |
| `reissue_credential(...)` | Authenticated | Atomic reissuance: old credential revoked + new issued in one tx |
| `get_credential_status(id)` | Public | Returns `"valid"`, `"revoked"`, or `"expired"` as a Symbol |
| `get_credential_details(id)` | Public | Full credential struct with all fields |
| `get_credentials_by_subject(did)` | Public | All credential IDs for a subject |
| `get_credentials_by_issuer(did)` | Public | All credential IDs issued by an issuer |
| `get_revocation_status(id)` | Public | `Option<RevocationEntry>` with revoker, reason, date, proof |

### Error Codes

| Code | Name | When |
|---|---|---|
| 4001 | `InvalidCredential` | Expired expiration_date at issuance, or other validity failure |
| 4002 | `UnauthorizedIssuer` | Caller not authorized |
| 4003 | `CredentialNotFound` | Credential ID does not exist in storage |
| 4004 | `AlreadyRevoked` | Attempting to revoke an already-revoked credential |
| 4005 | `ExpiredCredential` | Attempting to revoke an expired credential (use reissue instead) |
| 4006 | `InvalidProof` | Empty proof value |
| 4008 | `GovernanceError` | Governance role check failed |
| 4009 | `AlreadyInitialized` | Contract already initialized (double-init protection) |
| 4010 | `StillActive` | Attempting to reissue a credential that is still active |
| 4011 | `CredentialInvalid` | Credential is not valid for the requested operation |

### Events

| Topic | Payload |
|---|---|
| `cred_iss` | `CredentialIssuedEvent { credential_id, issuer_did, subject_did, credential_type, timestamp }` |
| `cred_rev` | `CredentialRevokedEvent { credential_id, revoked_by, reason, timestamp }` |
| `cred_reis` | `CredentialReissuedEvent { old_credential_id, new_credential_id, issuer, new_subject, old_subject, timestamp }` |
| `cred_exp` | `CredentialExpiredEvent { credential_id, expired_at }` |

### Revocation Record

```rust
pub struct RevocationEntry {
    pub credential_id: Symbol,    // The revoked credential ID
    pub revoker: Symbol,          // DID of the revoker
    pub revocation_date: u64,     // Ledger timestamp of revocation
    pub reason: Symbol,           // Human-readable reason
    pub proof: Bytes,             // Cryptographic proof of revocation authority
}
```

### Issuer Expectations

1. Call `issue_credential()` with a valid proof and non-past expiration date.
2. To revoke, call `revoke_credential()` with reason and proof — the credential must be active (not already revoked or expired).
3. To reissue, call `reissue_credential()` — the old credential must be revoked or expired. Active credentials return `StillActive`.
4. Use `get_credential_status()` to check state before operations.

### Verifier Expectations

1. Call `verify_credential(id)` — returns `true` only for valid, non-revoked, non-expired credentials.
2. Use `get_credential_status(id)` for programmatic state checks (`"valid"`, `"revoked"`, `"expired"`).
3. Use `get_revocation_status(id)` to retrieve full revocation audit data when needed.
4. Always re-verify before trusting; credential state may change between checks.
