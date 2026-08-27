# Stellara Smart Contracts - Upgradeability Design

## Overview

This document defines the explicit upgradeability pattern for Stellara smart contracts on Soroban/Stellar. The design prioritizes security, transparency, and decentralized governance while preventing rogue upgrades through multi-signature approval and timelock mechanisms.

## 1. Upgradeability Architecture

### 1.1 Design Pattern: Governance-Controlled Upgrade

Stellara uses a **decentralized governance upgrade model** rather than a traditional proxy pattern. This approach:

- **Eliminates centralized admin risk**: Upgrades require multi-signature approval
- **Provides transparency**: All upgrade proposals are on-chain and auditable
- **Includes timelock delays**: Users have time to react before upgrades take effect
- **Maintains simplicity**: Contracts are immutable; we manage upgradeability through governance

### 1.2 Contract Immutability on Stellar/Soroban

Since Soroban contracts are immutable once deployed:

1. **Original contract remains**: The contract code on-chain cannot be changed
2. **Version management**: Contracts include a `version` field to track implementation versions
3. **Upgrade path**: New contracts are deployed with upgraded code; governance manages the transition
4. **Data migration**: State can be migrated through `init` and state-transfer functions

### 1.3 Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│              Stellara Governance System                  │
└─────────────────────────────────────────────────────────┘

User/Admin
    │
    ├─► propose_upgrade()
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│         Upgrade Proposal (On-Chain)                      │
│  ┌─────────────────────────────────────────────────────┐│
│  │ • Proposer (Admin)                                   ││
│  │ • New Contract Hash / Address                        ││
│  │ • Description                                        ││
│  │ • Approval Threshold (e.g., 2 of 3)                ││
│  │ • Approvers List                                     ││
│  │ • Status: Pending                                    ││
│  │ • Timelock Expiration                               ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘

Multi-Signature Approval Phase
    │
    ├─► Approver 1: approve_upgrade()   [APPROVAL 1/2]
    │
    ├─► Approver 2: approve_upgrade()   [APPROVAL 2/2 ✓ APPROVED]
    │
    └─► (Approver 3: can still reject or approve)

Timelock Phase (Security Delay)
    │
    ├─► Current Time: Check if enough time has passed
    │
    └─► If timelock not expired: Execution blocked

Execution Phase
    │
    └─► Executor: execute_upgrade()
        │
        ├─► Verify: Approved status ✓
        ├─► Verify: Timelock expired ✓
        └─► Execute upgrade
            ├─► Update version number
            ├─► Emit upgrade event
            └─► Mark proposal as executed
```

## 2. Security Safeguards

### 2.1 Role-Based Access Control

Three distinct governance roles prevent single-point-of-failure:

```
┌──────────────────────────────────────────────────────┐
│           Governance Role Hierarchy                   │
├──────────────────────────────────────────────────────┤
│ Admin (Level 0)                                       │
│  • Can propose upgrades                              │
│  • Can cancel pending proposals                      │
│  • Can pause/unpause contract                        │
│  • Highest privilege level                           │
├──────────────────────────────────────────────────────┤
│ Approver (Level 1)                                   │
│  • Can approve/reject proposals                      │
│  • Cannot execute                                    │
│  • Acts as check on admin power                      │
├──────────────────────────────────────────────────────┤
│ Executor (Level 2)                                   │
│  • Can only execute approved proposals              │
│  • Cannot approve or propose                         │
│  • Final enforcement mechanism                       │
└──────────────────────────────────────────────────────┘
```

**Benefits:**
- **Separation of Concerns**: No single actor can execute an upgrade
- **Distributed Trust**: Requires cooperation between multiple parties
- **Reduced Attack Surface**: Each role has minimal necessary permissions

### 2.2 Multi-Signature Approval (M-of-N)

Upgrades require N approvals from a configurable threshold:

```
Example: 2-of-3 Multi-Sig

Approvers: Alice, Bob, Charlie
Threshold: 2 approvals needed

Scenarios:
✓ Alice + Bob approve       → Proposal becomes APPROVED
✓ Alice + Charlie approve   → Proposal becomes APPROVED
✓ Bob + Charlie approve     → Proposal becomes APPROVED
✗ Only Alice approves       → Proposal remains PENDING
✗ Only Bob approves         → Proposal remains PENDING
```

**Implementation Details:**
- Duplicate approvals are prevented (one signature per approver)
- Any approver can reject, removing the proposal from consideration
- Approval threshold is validated during proposal creation
- Each proposal tracks approval count and approver list

### 2.3 Timelock Delay (Security Delay)

After approval, upgrades cannot execute immediately:

```
Timeline Example: 4-hour Timelock

T0: proposal_created()
    ├─► execution_time = T0 + 14,400 seconds (4 hours)

T0 to T0+4h: Approvers review and approve
    ├─► Proposal reaches 2-of-3 threshold
    ├─► Status = APPROVED
    ├─► execution_time still in future

T0+4h: Timelock expires
    ├─► Execute can now be called
    ├─► Executor validates timelock has passed
    └─► If valid, upgrade executes

Benefit: Users have time to:
  • Review proposed changes
  • Migrate to new contract if needed
  • Exit protocol if concerned about changes
  • Present objections to governance
```

**Configurable Delays:**
- Minimum timelock: 1 hour (3,600 seconds)
- Standard timelock: 4-24 hours
- Maximum timelock: 7-30 days (depends on governance parameters)

### 2.4 Proposal Lifecycle

Proposals progress through well-defined states:

```
┌──────────────────────────────────────────────────────┐
│ PENDING                                               │
│ ├─ Waiting for approvals                             │
│ ├─ Approvers can: approve(), reject()                │
│ └─ Requires: approval_threshold approvals            │
└─────────────┬──────────────────────────────────────┘
              │
        ┌─────┴──────┬──────────┐
        │            │          │
        ▼            ▼          ▼
    APPROVED    REJECTED    CANCELLED
        │            │          │
        │            └──────────┴─── End (No execution)
        │
   (Timelock)
        │
        ▼
    EXECUTED
```

**State Rules:**
- Only PENDING proposals can be approved/rejected
- Only APPROVED proposals can be executed
- Only proposals created by admin can be cancelled
- Cannot approve an executed, rejected, or cancelled proposal
- Cannot execute before timelock expiration

### 2.5 Rejection & Cancellation

Provides circuit-breakers for malicious or erroneous proposals:

```
Rejection (by any Approver):
  • Immediately transitions proposal to REJECTED
  • No further actions possible
  • Requires: Approver role
  • Use case: Detect suspicious upgrade

Cancellation (by Admin only):
  • Cancels pending or approved proposals
  • Available only before execution
  • Requires: Admin role
  • Use case: Mistake correction, emergency halt
```

## 3. Governance Process Flow

### 3.1 Step-by-Step Upgrade Process

```
STEP 1: PROPOSAL
├─ Admin calls: propose_upgrade()
├─ Parameters:
│   ├─ new_contract_hash: Symbol (IPFS hash or contract address)
│   ├─ description: Symbol (human-readable rationale)
│   ├─ approvers: Vec<Address> (list of 3+ signers)
│   ├─ approval_threshold: u32 (e.g., 2 of 3)
│   └─ timelock_delay: u64 (seconds, e.g., 14400)
├─ Returns: proposal_id
└─ Status: Pending

STEP 2: MULTI-SIG APPROVAL
├─ Approver 1 calls: approve_upgrade(proposal_id)
│   └─ approvals_count = 1/2
├─ Approver 2 calls: approve_upgrade(proposal_id)
│   ├─ approvals_count = 2/2 ✓
│   └─ Status changes to: APPROVED
└─ Timelock begins counting from approval

STEP 3: SECURITY DELAY
├─ Wait for timelock period to expire
├─ Current time < execution_time: Cannot execute
└─ Current time >= execution_time: Ready for execution

STEP 4: EXECUTION
├─ Executor calls: execute_upgrade(proposal_id)
├─ Validates:
│   ├─ Proposal status is APPROVED ✓
│   ├─ Timelock has expired ✓
│   └─ Executor has proper role ✓
├─ Updates proposal:
│   ├─ Status = EXECUTED
│   ├─ executed = true
│   └─ Block timestamp recorded
└─ Contract upgrade takes effect
```

### 3.2 Rejection Example

```
STEP 1: PROPOSAL (same as above)
STEP 2: REJECTION
├─ Approver 1 calls: approve_upgrade(proposal_id)
│   └─ approvals_count = 1/2
├─ Approver 2 calls: reject_upgrade(proposal_id)
│   ├─ Status changes to: REJECTED
│   └─ No further action possible
└─ Proposal is discarded

Reason: Approver 2 detected security issues or disagreed
```

## 4. Smart Contract Implementation

### 4.1 Core Data Structures

```rust
pub struct UpgradeProposal {
    pub id: u64,                           // Unique ID
    pub proposer: Address,                 // Who created it
    pub new_contract_hash: Symbol,         // New contract identifier
    pub target_contract: Address,          // Contract being upgraded
    pub description: Symbol,               // Upgrade rationale
    pub approval_threshold: u32,           // e.g., 2 (for 2-of-3)
    pub approvers: Vec<Address>,           // 3+ signers
    pub approvals_count: u32,              // Current approvals
    pub status: ProposalStatus,            // Pending/Approved/Executed
    pub created_at: u64,                   // Ledger timestamp
    pub execution_time: u64,               // Earliest execution (created + delay)
    pub executed: bool,                    // Final state flag
}

pub enum ProposalStatus {
    Pending = 0,      // Awaiting approvals
    Approved = 1,     // Met threshold, in timelock
    Rejected = 2,     // Disapproved by approver
    Executed = 3,     // Upgrade completed
    Cancelled = 4,    // Cancelled by admin
}

pub enum GovernanceRole {
    Admin = 0,        // Propose & cancel
    Approver = 1,     // Approve & reject
    Executor = 2,     // Execute
}
```

### 4.2 Key Functions

#### propose_upgrade()
```rust
pub fn propose_upgrade(
    new_contract_hash: Symbol,
    description: Symbol,
    approvers: Vec<Address>,
    approval_threshold: u32,
    timelock_delay: u64,
) -> Result<u64, GovernanceError>
```

**Requirements:**
- Caller must be Admin
- Threshold must be > 0 and ≤ approvers.len()
- Returns proposal_id

**Safeguards:**
- Validates approver count
- Checks threshold consistency
- Enforces timelock minimum

#### approve_upgrade()
```rust
pub fn approve_upgrade(
    proposal_id: u64,
    approver: Address,
) -> Result<(), GovernanceError>
```

**Requirements:**
- Caller must be Approver role
- Caller must be in approvers list
- Proposal status must be Pending
- Cannot approve twice

**Automatic Transitions:**
- When approvals_count >= threshold → Status = Approved

#### execute_upgrade()
```rust
pub fn execute_upgrade(
    proposal_id: u64,
    executor: Address,
) -> Result<(), GovernanceError>
```

**Requirements:**
- Caller must be Executor role
- Proposal status must be Approved
- Current timestamp ≥ execution_time

**Effects:**
- Sets status to Executed
- Sets executed flag to true
- Locks proposal (no further changes)

## 5. Initializer Protection

### 5.1 Pattern

Every upgradeable contract uses the shared `upgradeability` crate for
initializer protection.  The guard uses a single persistent storage key
(`"init"`) that is written during the first successful call to
`initialize()`.  All subsequent calls check this key and return an
`AlreadyInitialized` error before touching any other state.

```rust
// Every initialize() implementation follows this pattern:
pub fn initialize(env: Env, admin: Address, ...) -> Result<(), XxxError> {
    // 1. Check guard first — before any state is written.
    if upgradeability::is_initialized(&env) {
        return Err(XxxError::AlreadyInitialized);
    }
    // 2. Atomically mark initialized.
    upgradeability::mark_initialized(&env);

    // 3. Write the rest of the initialization state.
    // ...
    Ok(())
}
```

**Why `is_initialized` + `mark_initialized` instead of `initializer_guard`?**

Using the two-step form returns a typed error rather than panicking, which
allows callers (e.g., the deploy script and integration tests) to inspect
the exact failure mode rather than catching an opaque host-level trap.

### 5.2 Contracts with Initializer Protection

| Contract                | Error variant           | Guard location      |
|-------------------------|-------------------------|---------------------|
| `trading`               | `Unauthorized` (panic)  | `initializer_guard` |
| `messaging`             | `Unauthorized` (panic)  | `initializer_guard` |
| `did-registry`          | `AlreadyInitialized`    | `is_initialized`    |
| `identity-hub`          | `AlreadyInitialized`    | `is_initialized`    |
| `verifiable-credentials`| `AlreadyInitialized`    | `is_initialized`    |

### 5.3 Test Coverage

```
upgradeability crate (cargo test -p upgradeability)
  ✓ test_fresh_contract_is_not_initialized
  ✓ test_mark_initialized_sets_flag
  ✓ test_initializer_guard_succeeds_on_first_call
  ✓ test_is_initialized_returns_false_before_mark
  ✓ test_is_initialized_returns_true_after_mark

integration-tests/tests/initializer_protection.rs
  ✓ test_trading_contract_initializes_successfully
  ✓ test_trading_double_initialization_blocked
  ✓ test_messaging_contract_initializes_successfully
  ✓ test_messaging_double_initialization_blocked

integration-tests/tests/upgrade_paths.rs  (NEW)
  ✓ did_registry_initializes_once
  ✓ did_registry_double_init_blocked
  ✓ did_registry_state_preserved_across_upgrade_simulation
  ✓ identity_hub_initializes_once
  ✓ identity_hub_double_init_blocked
  ✓ identity_hub_hub_count_preserved_after_init
  ✓ identity_hub_upgrade_simulation_guard
  ✓ vc_initializes_once
  ✓ vc_double_init_blocked
  ✓ vc_credential_count_starts_at_zero
  ✓ vc_issue_and_verify_round_trip
  ✓ vc_revoke_invalidates_credential
  ✓ vc_upgrade_simulation_guard

did-registry crate (cargo test -p did-registry)
  ✓ test_initialize
  ✓ test_double_initialize_is_rejected
  ✓ test_create_stellar_did
  ✓ test_create_key_did
  ✓ test_add_verification_method
  ✓ test_add_service
  ✓ test_deactivate_did
  ✓ test_get_all_dids
```

## 6. Testing & Validation

### 6.1 Rollback Testing

While Soroban contracts are immutable, rollback scenarios are tested:

```
Scenario: Upgrade introduces bugs
├─ Detect issue within timelock period
├─ Execute: reject_upgrade() or cancel_upgrade()
├─ Fallback: redirect traffic to v1 contract
├─ Migration: transition state back to v1
└─ Communication: notify users of rollback

Time Requirements:
  • Detection window = timelock_delay
  • Minimum window = 1 hour
  • Recommended = 4-24 hours
```

## 7. Security Considerations

### 6.1 Attack Vectors & Mitigations

| Attack Vector | Mitigation |
|---------------|-----------|
| Rogue admin proposal | Requires multi-sig approval |
| Sybil attack on approvers | Whitelist-based approver list |
| Timelock bypass | Enforced delay in contract logic |
| Duplicate approval | Tracked in on-chain storage |
| Unauthorized execution | Role-based access control |
| Front-running proposal | Transparent on-chain proposal |
| State loss during upgrade | Explicit data migration handlers |

### 6.2 Governance Best Practices

1. **Multi-Sig Signers**: Use 3-of-5 or higher for mainnet
2. **Geographic Distribution**: Signers in different jurisdictions
3. **Key Management**: Hardware wallets for approval keys
4. **Timelock Duration**: 
   - Testnet: 1 hour minimum
   - Mainnet: 24 hours minimum
5. **Communication**: Announce upgrades 48 hours in advance
6. **Emergency Procedures**: Define escalation path for critical issues

### 6.3 Threat Model

**In Scope (This design prevents):**
- Single admin rogue upgrade ✓
- Unilateral governance changes ✓
- Undetected malicious code deployment ✓
- Signer collusion (up to threshold-1) ✓

**Out of Scope (Require external measures):**
- All N approvers colluding (governance failure)
- Soroban/Stellar network compromise
- Contract bug in shared library
- Social engineering of signers

## 8. State Management & Upgradability

### 7.1 Version Tracking

Each contract maintains a version:

```rust
const CONTRACT_VERSION: u32 = 1;

pub fn get_version(env: Env) -> u32 {
    // Returns current version
}
```

**Version Schema:**
- V1: Initial release
- V2: Upgrade with new features
- V3+: Subsequent improvements

### 7.2 Data Migration

When deploying V2, handle state transitions:

```rust
// V1 contract: stores stats in persistent storage
pub struct TradeStats {
    pub total_trades: u64,
    pub total_volume: i128,
}

// V2 contract: extends with fees_collected
pub struct TradeStats {
    pub total_trades: u64,
    pub total_volume: i128,
    pub fees_collected: i128,  // NEW in V2
}

// Migration function in V2 init:
pub fn migrate_from_v1(env: Env) {
    let old_stats = load_old_stats(env);
    let new_stats = TradeStats {
        total_trades: old_stats.total_trades,
        total_volume: old_stats.total_volume,
        fees_collected: 0,  // Initialize new field
    };
    save_stats(env, new_stats);
}
```

### 7.3 Solidity Storage-Gap Discipline (MultisigTreasury)

`Contracts/contracts/MultisigTreasury.sol` is the EVM-side counterpart of the
Soroban governance stack and is deployed behind a proxy, so it cannot rely on
Soroban's per-key storage model. It reserves a trailing gap instead:

```solidity
uint256[46] private __gap;
```

The rule when adding state is: **append new variables immediately before
`__gap`, then reduce the gap by the number of slots actually consumed**, so the
combined footprint of the declared variables plus the gap never changes and no
following slot shifts across versions.

The batch/pause release illustrates both cases:

| Variable     | Slots consumed | Why                                                   |
| :----------- | :------------- | :---------------------------------------------------- |
| `paused`     | 0              | A `bool` packed into the existing `frozen` slot       |
| `batchNonce` | 1              | A `uint256` appended before the gap                   |

Hence `__gap` went from 47 to 46 slots, not 45. Packing a `bool` next to an
existing `bool` is layout-neutral — the byte it occupies was already allocated
and zero in the previous version — but it must still be reasoned about
explicitly, because the moment a packed variable no longer fits the current slot
it silently claims a new one and shifts everything after it.

**Verification before any upgrade:**

- [ ] Declared-variable slots + `__gap` size is unchanged from the prior version
- [ ] New variables are appended, never inserted between existing ones
- [ ] Existing variable types and order are untouched
- [ ] `npx hardhat test test/MultisigTreasury.test.js` passes, including the
      storage-layout test that asserts every public governance field

### 7.4 Governance Pause vs. Upgrade Freeze

Two independent halt mechanisms exist and should not be conflated during an
incident:

| Mechanism                         | Scope                                      | Approval               |
| :-------------------------------- | :----------------------------------------- | :--------------------- |
| Admin pause (§2.1, Soroban)       | Stops contract entry points and upgrades   | Admin role             |
| Treasury pause (`pause`)          | Stops new treasury operations; keeps the emergency-withdrawal hatch open | `required` M-of-N |
| Treasury freeze (`emergencyFreeze`) | Stops everything except `unfreezeInternal` | Unanimous            |

A treasury pause is the correct first response to a suspected treasury issue: it
is fast (base threshold, no timelock) and still lets owners move funds out under
unanimous approval. Escalate to a freeze only when funds should not move at all,
and pause the Soroban side separately if the incident involves an upgrade
proposal. See [README_TREASURY.md](./README_TREASURY.md) for the full pause and
emergency-withdrawal runbook.

## 9. Transparency & User Communication

### 8.1 Proposal Visibility

All proposals are queryable:

```
get_upgrade_proposal(proposal_id) -> UpgradeProposal

Returns:
{
  "id": 1,
  "proposer": "GXXXXXX...",
  "new_contract_hash": "QmXXXX...",
  "description": "Add fee collection feature",
  "approval_threshold": 2,
  "approvals_count": 1,
  "status": "Pending",
  "execution_time": 1678900000,
  "created_at": 1678886400
}
```

### 8.2 User Notification

Recommended notification timeline:

```
T0 + 0h:    Governance proposes upgrade
T0 + 12h:   Alerts sent to user community
T0 + 24h:   Multi-sig phase begins
T0 + 48h:   Timelock expires, upgrade ready
T0 + 49h:   Upgrade executes if approved
```

## 10. Deployment Checklist

Before deploying to mainnet:

- [ ] All governance roles assigned
- [ ] Multi-sig signers identified and verified
- [ ] Minimum timelock set to 24 hours
- [ ] Proposal creation tested end-to-end
- [ ] Approval workflow tested with dummy proposals
- [ ] Timelock enforcement verified
- [ ] Rejection/cancellation tested
- [ ] `cargo test -p upgradeability` passes
- [ ] `cargo test -p integration-tests --test initializer_protection` passes
- [ ] `cargo test -p integration-tests --test upgrade_paths` passes
- [ ] `cargo test -p did-registry` passes
- [ ] `npx hardhat test test/MultisigTreasury.test.js` passes (batch atomicity,
      pause gates, emergency withdrawals, storage layout)
- [ ] Treasury storage-gap invariant re-checked against the prior version (§7.3)
- [ ] Treasury pause/unpause and emergency withdrawal rehearsed on testnet
- [ ] Double-init rejection verified on deployed contracts (deploy script step 8)
- [ ] Documentation shared with community
- [ ] Emergency escalation path documented
- [ ] Monitoring alerts configured

## 11. References

### Soroban/Stellar Documentation
- [Soroban Smart Contracts](https://developers.stellar.org/docs/smart-contracts)
- [Access Control Patterns](https://developers.stellar.org/docs/learn/storing-data)
- [Contract Testing](https://developers.stellar.org/docs/build/smart-contracts/testing)

### Smart Contract Security
- [OpenZeppelin Governance](https://docs.openzeppelin.com/contracts/latest/governance)
- [Multi-Sig Wallets](https://blog.gnosis.pm/multisig-wallets)
- [Timelock Mechanisms](https://eips.ethereum.org/EIPS/eip-1014)

---

**Last Updated**: August 27, 2026  
**Version**: 1.1  
**Status**: Active
