//! Standardized event types for on-chain action logging
//!
//! This module provides consistent event structures for off-chain indexing
//! and notification systems. All contracts should use these event types
//! to ensure reliable backend integration.

use soroban_sdk::{contracttype, Address, Symbol};

// =============================================================================
// Event Topics (standardized event names)
// =============================================================================

/// Standard event topic names for consistent indexing
pub mod topics {
    use soroban_sdk::{symbol_short, Symbol};

    // Trading events
    pub const TRADE_EXECUTED: Symbol = symbol_short!("trade");
    pub const CONTRACT_PAUSED: Symbol = symbol_short!("paused");
    pub const CONTRACT_UNPAUSED: Symbol = symbol_short!("unpause");
    pub const FEE_COLLECTED: Symbol = symbol_short!("fee");
        // Audit logging
    pub const AUDIT_ACTION: Symbol = symbol_short!("audit_ac");
    pub const ACCESS_DENIED: Symbol = symbol_short!("acc_den");

    // Governance events
    pub const PROPOSAL_CREATED: Symbol = symbol_short!("propose");
    pub const PROPOSAL_APPROVED: Symbol = symbol_short!("approve");
    pub const PROPOSAL_REJECTED: Symbol = symbol_short!("reject");
    pub const PROPOSAL_EXECUTED: Symbol = symbol_short!("execute");
    pub const PROPOSAL_CANCELLED: Symbol = symbol_short!("cancel");

    // Social rewards events
    pub const REWARD_ADDED: Symbol = symbol_short!("reward");
    pub const REWARD_CLAIMED: Symbol = symbol_short!("claimed");

    // Parametric insurance events
    pub const POLICY_CREATED: Symbol = symbol_short!("pol_crt");
    pub const POLICY_CANCELLED: Symbol = symbol_short!("pol_cnl");
    pub const POLICY_EXPIRED: Symbol = symbol_short!("pol_exp");
    pub const TRIGGER_ACTIVATED: Symbol = symbol_short!("trig_act");
    pub const CLAIM_PAID: Symbol = symbol_short!("clm_paid");
    pub const LIQUIDITY_DEPOSITED: Symbol = symbol_short!("liq_dep");
    pub const LIQUIDITY_WITHDRAWN: Symbol = symbol_short!("liq_wdraw");

    // Token events (for reference - already implemented in token contract)
    pub const TRANSFER: Symbol = symbol_short!("transfer");
    pub const MINT: Symbol = symbol_short!("mint");
    pub const BURN: Symbol = symbol_short!("burn");
}

// =============================================================================
// Trading Events
// =============================================================================

/// Event emitted when a trade is executed
#[contracttype]
#[derive(Clone, Debug)]
pub struct TradeExecutedEvent {
    /// Unique trade identifier
    pub trade_id: u64,
    /// Address of the trader
    pub trader: Address,
    /// Trading pair symbol (e.g., "XLMUSDC")
    pub pair: Symbol,
    /// Trade amount
    pub amount: i128,
    /// Trade price
    pub price: i128,
    /// Whether this is a buy (true) or sell (false)
    pub is_buy: bool,
    /// Fee amount collected
    pub fee_amount: i128,
    /// Token used for fee payment
    pub fee_token: Address,
    /// Block timestamp when trade occurred
    pub timestamp: u64,
}

/// Event emitted when contract is paused
#[contracttype]
#[derive(Clone, Debug)]
pub struct ContractPausedEvent {
    /// Admin who paused the contract
    pub paused_by: Address,
    /// Block timestamp when paused
    pub timestamp: u64,
}

/// Event emitted when contract is unpaused
#[contracttype]
#[derive(Clone, Debug)]
pub struct ContractUnpausedEvent {
    /// Admin who unpaused the contract
    pub unpaused_by: Address,
    /// Block timestamp when unpaused
    pub timestamp: u64,
}

/// Event emitted when a fee is collected
#[contracttype]
#[derive(Clone, Debug)]
pub struct FeeCollectedEvent {
    /// Address paying the fee
    pub payer: Address,
    /// Address receiving the fee
    pub recipient: Address,
    /// Fee amount
    pub amount: i128,
    /// Token used for payment
    pub token: Address,
    /// Block timestamp
    pub timestamp: u64,
}

// =============================================================================
// Governance Events
// =============================================================================

/// Event emitted when an upgrade proposal is created
#[contracttype]
#[derive(Clone, Debug)]
pub struct ProposalCreatedEvent {
    /// Unique proposal identifier
    pub proposal_id: u64,
    /// Address that created the proposal
    pub proposer: Address,
    /// Hash of the new contract to upgrade to
    pub new_contract_hash: Symbol,
    /// Contract being upgraded
    pub target_contract: Address,
    /// Description of the proposal
    pub description: Symbol,
    /// Required approvals for execution
    pub approval_threshold: u32,
    /// Timelock delay before execution (seconds)
    pub timelock_delay: u64,
    /// Block timestamp when created
    pub timestamp: u64,
}

/// Event emitted when a proposal is approved
#[contracttype]
#[derive(Clone, Debug)]
pub struct ProposalApprovedEvent {
    /// Proposal identifier
    pub proposal_id: u64,
    /// Address that approved
    pub approver: Address,
    /// Current approval count after this approval
    pub current_approvals: u32,
    /// Required approvals for execution
    pub threshold: u32,
    /// Block timestamp
    pub timestamp: u64,
}

/// Event emitted when a proposal is rejected
#[contracttype]
#[derive(Clone, Debug)]
pub struct ProposalRejectedEvent {
    /// Proposal identifier
    pub proposal_id: u64,
    /// Address that rejected
    pub rejector: Address,
    /// Block timestamp
    pub timestamp: u64,
}

/// Event emitted when a proposal is executed
#[contracttype]
#[derive(Clone, Debug)]
pub struct ProposalExecutedEvent {
    /// Proposal identifier
    pub proposal_id: u64,
    /// Address that executed
    pub executor: Address,
    /// New contract hash that was deployed
    pub new_contract_hash: Symbol,
    /// Block timestamp
    pub timestamp: u64,
}

/// Event emitted when a proposal is cancelled
#[contracttype]
#[derive(Clone, Debug)]
pub struct ProposalCancelledEvent {
    /// Proposal identifier
    pub proposal_id: u64,
    /// Admin who cancelled
    pub cancelled_by: Address,
    /// Block timestamp
    pub timestamp: u64,
}

// =============================================================================
// Social Rewards Events
// =============================================================================

/// Event emitted when a reward is added/granted to a user
#[contracttype]
#[derive(Clone, Debug)]
pub struct RewardAddedEvent {
    /// Unique reward identifier
    pub reward_id: u64,
    /// User receiving the reward
    pub user: Address,
    /// Reward amount
    pub amount: i128,
    /// Type of reward (e.g., "referral", "engagement", "achievement")
    pub reward_type: Symbol,
    /// Optional metadata/reason for the reward
    pub reason: Symbol,
    /// Admin who granted the reward
    pub granted_by: Address,
    /// Block timestamp
    pub timestamp: u64,
}

/// Event emitted when a reward is claimed
#[contracttype]
#[derive(Clone, Debug)]
pub struct RewardClaimedEvent {
    /// Reward identifier
    pub reward_id: u64,
    /// User who claimed
    pub user: Address,
    /// Amount claimed
    pub amount: i128,
    /// Block timestamp
    pub timestamp: u64,
}

// =============================================================================
// Parametric Insurance Events
// =============================================================================

/// Emitted when a new parametric insurance policy is created
#[contracttype]
#[derive(Clone, Debug)]
pub struct PolicyCreatedEvent {
    /// Unique policy identifier
    pub policy_id: u64,
    /// Address of the insured party
    pub policyholder: Address,
    /// Payout amount if the trigger fires
    pub coverage_amount: i128,
    /// Premium paid upfront
    pub premium_amount: i128,
    /// Unix timestamp when the coverage window expires
    pub end_time: u64,
    /// Block timestamp when the policy was created
    pub timestamp: u64,
}

/// Emitted when a policyholder cancels their active policy
#[contracttype]
#[derive(Clone, Debug)]
pub struct PolicyCancelledEvent {
    /// Policy identifier
    pub policy_id: u64,
    /// Policyholder who cancelled
    pub policyholder: Address,
    /// Block timestamp
    pub timestamp: u64,
}

/// Emitted when a policy's coverage window lapses without a trigger
#[contracttype]
#[derive(Clone, Debug)]
pub struct PolicyExpiredEvent {
    /// Policy identifier
    pub policy_id: u64,
    /// Policyholder whose coverage expired
    pub policyholder: Address,
    /// Block timestamp
    pub timestamp: u64,
}

/// Emitted when an oracle condition is met and a payout is initiated
#[contracttype]
#[derive(Clone, Debug)]
pub struct TriggerActivatedEvent {
    /// Policy identifier
    pub policy_id: u64,
    /// Policyholder receiving the payout
    pub policyholder: Address,
    /// Oracle value that caused the trigger
    pub oracle_value: i128,
    /// The predefined threshold
    pub trigger_threshold: i128,
    /// Coverage amount being paid out
    pub coverage_amount: i128,
    /// Block timestamp
    pub timestamp: u64,
}

/// Emitted when a payout is transferred to the policyholder
#[contracttype]
#[derive(Clone, Debug)]
pub struct ClaimPaidEvent {
    /// Policy identifier
    pub policy_id: u64,
    /// Recipient of the payout
    pub policyholder: Address,
    /// Amount transferred
    pub amount: i128,
    /// Block timestamp
    pub timestamp: u64,
}

/// Emitted when a liquidity provider deposits into the risk pool
#[contracttype]
#[derive(Clone, Debug)]
pub struct LiquidityDepositedEvent {
    /// Address that deposited
    pub provider: Address,
    /// Amount deposited
    pub amount: i128,
    /// Block timestamp
    pub timestamp: u64,
}

/// Emitted when a liquidity provider withdraws from the risk pool
#[contracttype]
#[derive(Clone, Debug)]
pub struct LiquidityWithdrawnEvent {
    /// Address that withdrew
    pub provider: Address,
    /// Amount withdrawn
    pub amount: i128,
    /// Block timestamp
    pub timestamp: u64,
}

// =============================================================================
// Event Emission Helpers
// =============================================================================

use soroban_sdk::Env;

/// Helper trait for emitting standardized events
pub struct EventEmitter;

impl EventEmitter {
    /// Emit a trade executed event
    pub fn trade_executed(env: &Env, event: TradeExecutedEvent) {
        env.events().publish((topics::TRADE_EXECUTED,), event);
    }

    /// Emit a contract paused event
    pub fn contract_paused(env: &Env, event: ContractPausedEvent) {
        env.events().publish((topics::CONTRACT_PAUSED,), event);
    }

    /// Emit a contract unpaused event
    pub fn contract_unpaused(env: &Env, event: ContractUnpausedEvent) {
        env.events().publish((topics::CONTRACT_UNPAUSED,), event);
    }

    /// Emit a fee collected event
    pub fn fee_collected(env: &Env, event: FeeCollectedEvent) {
        env.events().publish((topics::FEE_COLLECTED,), event);
    }

    /// Emit a proposal created event
    pub fn proposal_created(env: &Env, event: ProposalCreatedEvent) {
        env.events().publish((topics::PROPOSAL_CREATED,), event);
    }

    /// Emit a proposal approved event
    pub fn proposal_approved(env: &Env, event: ProposalApprovedEvent) {
        env.events().publish((topics::PROPOSAL_APPROVED,), event);
    }

    /// Emit a proposal rejected event
    pub fn proposal_rejected(env: &Env, event: ProposalRejectedEvent) {
        env.events().publish((topics::PROPOSAL_REJECTED,), event);
    }

    /// Emit a proposal executed event
    pub fn proposal_executed(env: &Env, event: ProposalExecutedEvent) {
        env.events().publish((topics::PROPOSAL_EXECUTED,), event);
    }

    /// Emit a proposal cancelled event
    pub fn proposal_cancelled(env: &Env, event: ProposalCancelledEvent) {
        env.events().publish((topics::PROPOSAL_CANCELLED,), event);
    }

    /// Emit a reward added event
    pub fn reward_added(env: &Env, event: RewardAddedEvent) {
        env.events().publish((topics::REWARD_ADDED,), event);
    }

    /// Emit a reward claimed event
    pub fn reward_claimed(env: &Env, event: RewardClaimedEvent) {
        env.events().publish((topics::REWARD_CLAIMED,), event);
    }

    // ── Parametric insurance emitters ─────────────────────────────────────────

    /// Emit a policy created event
    pub fn policy_created(env: &Env, event: PolicyCreatedEvent) {
        env.events().publish((topics::POLICY_CREATED,), event);
    }

    /// Emit a policy cancelled event
    pub fn policy_cancelled(env: &Env, event: PolicyCancelledEvent) {
        env.events().publish((topics::POLICY_CANCELLED,), event);
    }

    /// Emit a policy expired event
    pub fn policy_expired(env: &Env, event: PolicyExpiredEvent) {
        env.events().publish((topics::POLICY_EXPIRED,), event);
    }

    /// Emit a trigger activated event
    pub fn trigger_activated(env: &Env, event: TriggerActivatedEvent) {
        env.events().publish((topics::TRIGGER_ACTIVATED,), event);
    }

    /// Emit a claim paid event
    pub fn claim_paid(env: &Env, event: ClaimPaidEvent) {
        env.events().publish((topics::CLAIM_PAID,), event);
    }

    /// Emit a liquidity deposited event
    pub fn liquidity_deposited(env: &Env, event: LiquidityDepositedEvent) {
        env.events().publish((topics::LIQUIDITY_DEPOSITED,), event);
    }

    /// Emit a liquidity withdrawn event
    pub fn liquidity_withdrawn(env: &Env, event: LiquidityWithdrawnEvent) {
        env.events().publish((topics::LIQUIDITY_WITHDRAWN,), event);
    }
}

// =============================================================================
// DID Registry Events
// =============================================================================

/// Emitted when a new DID is created
#[contracttype]
#[derive(Clone, Debug)]
pub struct DidCreatedEvent {
    pub did: Symbol,
    pub controller: Address,
    pub method: Symbol,
    pub timestamp: u64,
}

/// Emitted when a DID document is updated
#[contracttype]
#[derive(Clone, Debug)]
pub struct DidUpdatedEvent {
    pub did: Symbol,
    pub controller: Address,
    pub timestamp: u64,
}

/// Emitted when a DID is permanently deactivated
#[contracttype]
#[derive(Clone, Debug)]
pub struct DidDeactivatedEvent {
    pub did: Symbol,
    pub deactivated_by: Address,
    pub timestamp: u64,
}

/// Emitted when a verification method is added to a DID
#[contracttype]
#[derive(Clone, Debug)]
pub struct VerificationMethodAddedEvent {
    pub did: Symbol,
    pub method_id: Symbol,
    pub controller: Address,
    pub timestamp: u64,
}

/// Emitted when a service endpoint is added to a DID
#[contracttype]
#[derive(Clone, Debug)]
pub struct ServiceAddedEvent {
    pub did: Symbol,
    pub service_id: Symbol,
    pub controller: Address,
    pub timestamp: u64,
}

// =============================================================================
// Identity Hub Events
// =============================================================================

/// Emitted when a new identity hub is created
#[contracttype]
#[derive(Clone, Debug)]
pub struct HubCreatedEvent {
    pub hub_id: Symbol,
    pub owner_did: Symbol,
    pub timestamp: u64,
}

/// Emitted when a data entry is added to a hub
#[contracttype]
#[derive(Clone, Debug)]
pub struct DataEntryAddedEvent {
    pub hub_id: Symbol,
    pub entry_id: Symbol,
    pub added_by: Address,
    pub timestamp: u64,
}

/// Emitted when a permission is granted on a hub
#[contracttype]
#[derive(Clone, Debug)]
pub struct PermissionGrantedEvent {
    pub hub_id: Symbol,
    pub permission_id: Symbol,
    pub grantee: Address,
    pub grantor: Address,
    pub timestamp: u64,
}

/// Emitted when a permission is revoked from a hub
#[contracttype]
#[derive(Clone, Debug)]
pub struct PermissionRevokedEvent {
    pub hub_id: Symbol,
    pub permission_id: Symbol,
    pub revoked_by: Address,
    pub timestamp: u64,
}

/// Emitted when a selective disclosure proof is created
#[contracttype]
#[derive(Clone, Debug)]
pub struct SelectiveDisclosureCreatedEvent {
    pub disclosure_id: Symbol,
    pub hub_id: Symbol,
    pub requester: Address,
    pub timestamp: u64,
}

// =============================================================================
// Verifiable Credentials Events
// =============================================================================

/// Emitted when a credential is issued
#[contracttype]
#[derive(Clone, Debug)]
pub struct CredentialIssuedEvent {
    pub credential_id: Symbol,
    pub issuer_did: Symbol,
    pub subject_did: Symbol,
    pub credential_type: Symbol,
    pub timestamp: u64,
}

/// Emitted when a credential is revoked
#[contracttype]
#[derive(Clone, Debug)]
pub struct CredentialRevokedEvent {
    pub credential_id: Symbol,
    pub revoked_by: Address,
    pub reason: Symbol,
    pub timestamp: u64,
}

/// Emitted when a credential is reissued (old burned, new minted)
#[contracttype]
#[derive(Clone, Debug)]
pub struct CredentialReissuedEvent {
    pub old_credential_id: Symbol,
    pub new_credential_id: Symbol,
    pub issuer: Symbol,
    pub new_subject: Symbol,
    pub old_subject: Symbol,
    pub timestamp: u64,
}

/// Emitted when a credential expires
#[contracttype]
#[derive(Clone, Debug)]
pub struct CredentialExpiredEvent {
    pub credential_id: Symbol,
    pub expired_at: u64,
}

// =============================================================================
// Synthetic Assets Events
// =============================================================================

/// Emitted when a synthetic asset is registered
#[contracttype]
#[derive(Clone, Debug)]
pub struct AssetRegisteredEvent {
    pub asset_symbol: Symbol,
    pub registered_by: Address,
    pub collateral_ratio: u32,
    pub timestamp: u64,
}

/// Emitted when a CDP is opened
#[contracttype]
#[derive(Clone, Debug)]
pub struct CdpOpenedEvent {
    pub owner: Address,
    pub asset_symbol: Symbol,
    pub collateral_amount: i128,
    pub timestamp: u64,
}

/// Emitted when a CDP is closed
#[contracttype]
#[derive(Clone, Debug)]
pub struct CdpClosedEvent {
    pub owner: Address,
    pub asset_symbol: Symbol,
    pub collateral_returned: i128,
    pub timestamp: u64,
}

/// Emitted when collateral is added to a CDP
#[contracttype]
#[derive(Clone, Debug)]
pub struct CollateralAddedEvent {
    pub owner: Address,
    pub asset_symbol: Symbol,
    pub amount: i128,
    pub new_ratio: u32,
    pub timestamp: u64,
}

/// Emitted when a CDP is liquidated
#[contracttype]
#[derive(Clone, Debug)]
pub struct CdpLiquidatedEvent {
    pub owner: Address,
    pub liquidator: Address,
    pub asset_symbol: Symbol,
    pub collateral_seized: i128,
    pub debt_repaid: i128,
    pub timestamp: u64,
}

/// Emitted when the oracle price for a synthetic asset is updated
#[contracttype]
#[derive(Clone, Debug)]
pub struct PriceUpdatedEvent {
    pub asset_symbol: Symbol,
    pub old_price: i128,
    pub new_price: i128,
    pub updated_by: Address,
    pub timestamp: u64,
}

// =============================================================================
// TCR (Token-Curated Registry) Events
// =============================================================================

/// Emitted when an application is submitted to the registry
#[contracttype]
#[derive(Clone, Debug)]
pub struct TcrApplicationEvent {
    pub listing_id: u32,
    pub applicant: Address,
    pub deposit: i128,
    pub metadata: Symbol,
    pub timestamp: u64,
}

/// Emitted when a listing is challenged
#[contracttype]
#[derive(Clone, Debug)]
pub struct TcrChallengedEvent {
    pub challenge_id: u32,
    pub listing_id: u32,
    pub challenger: Address,
    pub deposit: i128,
    pub timestamp: u64,
}

/// Emitted when a vote is cast in a challenge
#[contracttype]
#[derive(Clone, Debug)]
pub struct TcrVotedEvent {
    pub challenge_id: u32,
    pub voter: Address,
    pub side: bool,
    pub weight: i128,
    pub timestamp: u64,
}

/// Emitted when a challenge is resolved
#[contracttype]
#[derive(Clone, Debug)]
pub struct TcrResolvedEvent {
    pub listing_id: u32,
    pub challenge_id: u32,
    pub accepted: bool,
    pub timestamp: u64,
}

// =============================================================================
// Stablecoin Reserve Events
// =============================================================================

/// Emitted when a reserve asset is added
#[contracttype]
#[derive(Clone, Debug)]
pub struct ReserveAssetAddedEvent {
    pub asset: Address,
    pub target_allocation: u32,
    pub added_by: Address,
    pub timestamp: u64,
}

/// Emitted when a reserve asset config is updated
#[contracttype]
#[derive(Clone, Debug)]
pub struct ReserveAssetUpdatedEvent {
    pub asset: Address,
    pub new_allocation: u32,
    pub updated_by: Address,
    pub timestamp: u64,
}

/// Emitted when a redemption request is submitted
#[contracttype]
#[derive(Clone, Debug)]
pub struct RedemptionRequestedEvent {
    pub request_id: u64,
    pub requester: Address,
    pub amount: u128,
    pub timestamp: u64,
}

/// Emitted when a redemption is processed / fulfilled
#[contracttype]
#[derive(Clone, Debug)]
pub struct RedemptionProcessedEvent {
    pub request_id: u64,
    pub requester: Address,
    pub amount: u128,
    pub timestamp: u64,
}

// =============================================================================
// Extended topics
// =============================================================================

pub mod extended_topics {
    use soroban_sdk::{symbol_short, Symbol};

    // DID registry
    pub const DID_CREATED: Symbol             = symbol_short!("did_crt");
    pub const DID_UPDATED: Symbol             = symbol_short!("did_upd");
    pub const DID_DEACTIVATED: Symbol         = symbol_short!("did_deact");
    pub const VERIF_METHOD_ADDED: Symbol      = symbol_short!("vm_added");
    pub const SERVICE_ADDED: Symbol           = symbol_short!("svc_added");

    // Identity hub
    pub const HUB_CREATED: Symbol             = symbol_short!("hub_crt");
    pub const DATA_ENTRY_ADDED: Symbol        = symbol_short!("data_add");
    pub const PERM_GRANTED: Symbol            = symbol_short!("prm_grnt");
    pub const PERM_REVOKED: Symbol            = symbol_short!("perm_rev");
    pub const DISCLOSURE_CREATED: Symbol      = symbol_short!("disc_crt");

    // Verifiable credentials
    pub const CREDENTIAL_ISSUED: Symbol       = symbol_short!("cred_iss");
    pub const CREDENTIAL_REVOKED: Symbol      = symbol_short!("cred_rev");
    pub const CREDENTIAL_REISSUED: Symbol     = symbol_short!("cred_reis");
    pub const CREDENTIAL_EXPIRED: Symbol      = symbol_short!("cred_exp");

    // Synthetic assets
    pub const ASSET_REGISTERED: Symbol        = symbol_short!("asset_reg");
    pub const CDP_OPENED: Symbol              = symbol_short!("cdp_open");
    pub const CDP_CLOSED: Symbol              = symbol_short!("cdp_close");
    pub const COLLATERAL_ADDED: Symbol        = symbol_short!("col_add");
    pub const CDP_LIQUIDATED: Symbol          = symbol_short!("cdp_liq");
    pub const PRICE_UPDATED: Symbol           = symbol_short!("price_upd");

    // TCR
    pub const TCR_APPLIED: Symbol             = symbol_short!("tcr_apply");
    pub const TCR_CHALLENGED: Symbol          = symbol_short!("tcr_chall");
    pub const TCR_VOTED: Symbol               = symbol_short!("tcr_vote");
    pub const TCR_RESOLVED: Symbol            = symbol_short!("tcr_resol");

    // Stablecoin reserve
    pub const RESERVE_ASSET_ADDED: Symbol     = symbol_short!("res_add");
    pub const RESERVE_ASSET_UPDATED: Symbol   = symbol_short!("res_upd");
    pub const REDEMPTION_REQUESTED: Symbol    = symbol_short!("redm_req");
    pub const REDEMPTION_PROCESSED: Symbol    = symbol_short!("redm_proc");

    // Token (from #771 — kept here for discoverability)
    pub const APPROVE: Symbol                 = symbol_short!("approve");
    pub const VESTING_GRANTED: Symbol         = symbol_short!("v_grant");
    pub const VESTING_CLAIMED: Symbol         = symbol_short!("v_claim");
    pub const VESTING_REVOKED: Symbol         = symbol_short!("v_revoke");
} 
// =============================================================================
// Audit Logging Events
// =============================================================================

/// Generic structured event for any admin/governance state mutation.
/// Emitted alongside (not instead of) each contract's existing
/// domain-specific event, to give compliance/off-chain tooling a single
/// standardized shape to index across all contracts.
#[contracttype]
#[derive(Clone, Debug)]
pub struct AuditActionEvent {
    /// Address that performed the action
    pub actor: Address,
    /// Short name of the operation, e.g. "pause", "set_rate_limit"
    pub operation: Symbol,
    /// Human/machine-readable summary of the prior value (symbol-encoded;
    /// use "none" when not applicable, e.g. for a first-time set)
    pub old_value: Symbol,
    /// Summary of the new value being set
    pub new_value: Symbol,
    /// Correlation ID for off-chain log aggregation — callers should pass
    /// a per-call-site constant symbol (e.g. the operation name) unless a
    /// request-scoped ID is available
    pub correlation_id: Symbol,
    /// Block timestamp
    pub timestamp: u64,
}

/// Emitted when an address attempts an action it does not have
/// permission for. Distinct from silent `Err(Unauthorized)` returns so
/// security monitoring can index attempted-but-denied actions.
#[contracttype]
#[derive(Clone, Debug)]
pub struct AccessDeniedEvent {
    /// Address that attempted the action
    pub actor: Address,
    /// The permission or role that was required
    pub required_permission: Symbol,
    /// Short identifier of the resource/function being accessed
    pub resource: Symbol,
    pub timestamp: u64,
}

impl EventEmitter {
    /// Emit a standardized audit event for an admin/governance mutation.
    pub fn audit_action(env: &Env, event: AuditActionEvent) {
        env.events().publish((topics::AUDIT_ACTION,), event);
    }

    /// Emit an access-denied security event.
    pub fn access_denied(env: &Env, event: AccessDeniedEvent) {
        env.events().publish((topics::ACCESS_DENIED,), event);
    }
}