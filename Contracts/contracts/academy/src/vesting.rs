use shared::circuit_breaker::{CircuitBreaker, CircuitBreakerConfig};
use shared::events::{AccessDeniedEvent, AuditActionEvent, EventEmitter};
use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, Vec};

const MAX_BATCH_CLAIMS: u32 = 25;

/// Vesting schedule for an academy reward
#[contracttype]
#[derive(Clone, Debug)]
pub struct VestingSchedule {
    pub beneficiary: Address,
    pub amount: i128,
    pub start_time: u64,
    pub cliff: u64,    // Time (in seconds) before any tokens unlock
    pub duration: u64, // Total vesting duration (in seconds)
    pub claimed: bool,
    pub revoked: bool,
    pub revoke_time: u64, // When it was revoked (0 if not revoked)
}

/// Vesting grant event for off-chain indexing
#[contracttype]
#[derive(Clone, Debug)]
pub struct GrantEvent {
    pub grant_id: u64,
    pub beneficiary: Address,
    pub amount: i128,
    pub start_time: u64,
    pub cliff: u64,
    pub duration: u64,
    pub granted_at: u64,
    pub granted_by: Address,
}

/// Claim event for off-chain indexing
#[contracttype]
#[derive(Clone, Debug)]
pub struct ClaimEvent {
    pub grant_id: u64,
    pub beneficiary: Address,
    pub amount: i128,
    pub claimed_at: u64,
}

/// Alias event for vesting claim (VestingClaimed for indexer)
#[contracttype]
#[derive(Clone, Debug)]
pub struct VestingClaimed {
    pub grant_id: u64,
    pub beneficiary: Address,
    pub amount: i128,
    pub claimed_at: u64,
}

/// Credential issued event (alias for grant event)
#[contracttype]
#[derive(Clone, Debug)]
pub struct CredentialIssued {
    pub grant_id: u64,
    pub beneficiary: Address,
    pub amount: i128,
    pub start_time: u64,
    pub cliff: u64,
    pub duration: u64,
    pub granted_at: u64,
    pub granted_by: Address,
}

/// Revoke event for off-chain indexing
#[contracttype]
#[derive(Clone, Debug)]
pub struct RevokeEvent {
    pub grant_id: u64,
    pub beneficiary: Address,
    pub revoked_at: u64,
    pub revoked_by: Address,
}

/// Vesting error codes
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VestingError {
    Unauthorized = 4001,
    NotVested = 4002,
    AlreadyClaimed = 4003,
    InvalidSchedule = 4004,
    InsufficientBalance = 4005,
    GrantNotFound = 4006,
    Revoked = 4007,
    InvalidTimelock = 4008,
    NotEnoughTimeForRevoke = 4009,
    BatchTooLarge = 4010,
}

impl From<VestingError> for soroban_sdk::Error {
    fn from(error: VestingError) -> Self {
        soroban_sdk::Error::from_contract_error(error as u32)
    }
}

impl From<&VestingError> for soroban_sdk::Error {
    fn from(error: &VestingError) -> Self {
        soroban_sdk::Error::from_contract_error(*error as u32)
    }
}

impl From<soroban_sdk::Error> for VestingError {
    fn from(_error: soroban_sdk::Error) -> Self {
        VestingError::Unauthorized
    }
}

#[contract]
pub struct AcademyVestingContract;

fn load_schedules(env: &Env) -> Result<soroban_sdk::Map<u64, VestingSchedule>, VestingError> {
    env.storage()
        .persistent()
        .get(&symbol_short!("sched"))
        .ok_or(VestingError::GrantNotFound)
}

fn persist_schedules(env: &Env, schedules: &soroban_sdk::Map<u64, VestingSchedule>) {
    env.storage()
        .persistent()
        .set(&symbol_short!("sched"), schedules);
}

fn claimable_amount(
    env: &Env,
    grant_id: u64,
    beneficiary: &Address,
    schedule: &VestingSchedule,
) -> Result<i128, VestingError> {
    if schedule.beneficiary != *beneficiary {
        return Err(VestingError::Unauthorized);
    }

    if schedule.claimed {
        return Err(VestingError::AlreadyClaimed);
    }

    if schedule.revoked {
        return Err(VestingError::Revoked);
    }

    let current_time = env.ledger().timestamp();
    let vested_amount = AcademyVestingContract::calculate_vested_amount(schedule, current_time)?;

    if vested_amount == 0 {
        return Err(VestingError::NotVested);
    }

    let _ = grant_id;
    Ok(vested_amount)
}

#[contractimpl]
impl AcademyVestingContract {
    /// Initialize the vesting contract with admin and governance roles
    pub fn init(
        env: Env,
        admin: Address,
        reward_token: Address,
        governance: Address,
        cb_config: CircuitBreakerConfig,
    ) -> Result<(), VestingError> {
        // Check if already initialized
        let init_key = symbol_short!("init");
        if env.storage().persistent().has(&init_key) {
            return Err(VestingError::Unauthorized);
        }

        // Set initialization flag
        env.storage().persistent().set(&init_key, &true);

        // Store admin
        let admin_key = symbol_short!("admin");
        env.storage().persistent().set(&admin_key, &admin);

        // Store reward token
        let token_key = symbol_short!("token");
        env.storage().persistent().set(&token_key, &reward_token);

        // Store governance address
        let gov_key = symbol_short!("gov");
        env.storage().persistent().set(&gov_key, &governance);

        // Store roles for shared GovernanceManager compatibility
        let mut roles = soroban_sdk::Map::new(&env);
        roles.set(admin.clone(), shared::governance::GovernanceRole::Admin);
        env.storage()
            .persistent()
            .set(&symbol_short!("roles"), &roles);

        // Initialize grant counter
        let counter_key = symbol_short!("cnt");
        env.storage().persistent().set(&counter_key, &0u64);

        // Initialize circuit breaker
        CircuitBreaker::init(&env, cb_config);

        Ok(())
    }

    /// Grant a vesting schedule to a beneficiary
    pub fn grant_vesting(
        env: Env,
        admin: Address,
        beneficiary: Address,
        amount: i128,
        start_time: u64,
        cliff: u64,
        duration: u64,
    ) -> Result<u64, VestingError> {
        admin.require_auth();

        // Check pause state via CircuitBreaker
        CircuitBreaker::require_not_paused(&env, symbol_short!("grant"));

        // Verify caller is admin
        let admin_key = symbol_short!("admin");
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&admin_key)
            .ok_or(VestingError::Unauthorized)?;

        if admin != stored_admin {
            // Audit: record the denied attempt before failing
            EventEmitter::access_denied(
                &env,
                AccessDeniedEvent {
                    actor: admin,
                    required_permission: symbol_short!("admin"),
                    resource: symbol_short!("grant"),
                    timestamp: env.ledger().timestamp(),
                },
            );
            return Err(VestingError::Unauthorized);
        }

        // Validate schedule
        if amount <= 0 {
            return Err(VestingError::InvalidSchedule);
        }
        if cliff > duration {
            return Err(VestingError::InvalidSchedule);
        }

        // Get next grant ID
        let counter_key = symbol_short!("cnt");
        let grant_id: u64 = env.storage().persistent().get(&counter_key).unwrap_or(0u64);

        let next_id = grant_id + 1;

        // Create vesting schedule
        let schedule = VestingSchedule {
            beneficiary: beneficiary.clone(),
            amount,
            start_time,
            cliff,
            duration,
            claimed: false,
            revoked: false,
            revoke_time: 0,
        };

        // Store schedule
        let schedules_key = symbol_short!("sched");
        let mut schedules: soroban_sdk::Map<u64, VestingSchedule> = env
            .storage()
            .persistent()
            .get(&schedules_key)
            .unwrap_or_else(|| soroban_sdk::Map::new(&env));

        schedules.set(next_id, schedule);
        env.storage().persistent().set(&schedules_key, &schedules);

        // Update counter
        env.storage().persistent().set(&counter_key, &next_id);

        let current_timestamp = env.ledger().timestamp();

        // Emit grant event
        let grant_event = GrantEvent {
            grant_id: next_id,
            beneficiary: beneficiary.clone(),
            amount,
            start_time,
            cliff,
            duration,
            granted_at: current_timestamp,
            granted_by: admin.clone(),
        };

        env.events().publish((symbol_short!("grant"),), grant_event);

        // Emit CredentialIssued event (for indexer compatibility)
        let credential_event = CredentialIssued {
            grant_id: next_id,
            beneficiary,
            amount,
            start_time,
            cliff,
            duration,
            granted_at: current_timestamp,
            granted_by: admin.clone(),
        };

        env.events()
            .publish((symbol_short!("cred_iss"),), credential_event);

        // Audit: standardized admin-mutation event alongside the domain events above
        EventEmitter::audit_action(
            &env,
            AuditActionEvent {
                actor: admin,
                operation: symbol_short!("grant"),
                old_value: symbol_short!("none"),
                new_value: symbol_short!("active"),
                correlation_id: symbol_short!("grant"),
                timestamp: current_timestamp,
            },
        );

        Ok(next_id)
    }

    /// Claim vested tokens (atomic operation, single-claim semantics)
    pub fn claim(env: Env, grant_id: u64, beneficiary: Address) -> Result<i128, VestingError> {
        beneficiary.require_auth();

        let mut schedules = load_schedules(&env)?;
        let mut schedule = schedules.get(grant_id).ok_or(VestingError::GrantNotFound)?;
        let vested_amount = claimable_amount(&env, grant_id, &beneficiary, &schedule)?;

        // Verify contract has sufficient balance
        let token_key = symbol_short!("token");
        let token: Address = env
            .storage()
            .persistent()
            .get(&token_key)
            .ok_or(VestingError::Unauthorized)?;

        let token_client = soroban_sdk::token::Client::new(&env, &token);
        let balance = token_client.balance(&env.current_contract_address());

        if balance < vested_amount {
            return Err(VestingError::InsufficientBalance);
        }

        // Mark as claimed (atomic operation)
        schedule.claimed = true;
        schedules.set(grant_id, schedule.clone());
        persist_schedules(&env, &schedules);

        // Transfer tokens
        token_client.transfer(
            &env.current_contract_address(),
            &beneficiary,
            &vested_amount,
        );

        let current_time = env.ledger().timestamp();

        // Emit claim event
        let claim_event = ClaimEvent {
            grant_id,
            beneficiary: beneficiary.clone(),
            amount: vested_amount,
            claimed_at: current_time,
        };

        env.events().publish((symbol_short!("claim"),), claim_event);

        // Emit VestingClaimed event (for indexer)
        let vesting_claimed = VestingClaimed {
            grant_id,
            beneficiary,
            amount: vested_amount,
            claimed_at: current_time,
        };

        env.events()
            .publish((symbol_short!("v_claimed"),), vesting_claimed);

        Ok(vested_amount)
    }

    /// Claim multiple vested rewards atomically for a single beneficiary.
    pub fn batch_claim(
        env: Env,
        grant_ids: Vec<u64>,
        beneficiary: Address,
    ) -> Result<i128, VestingError> {
        beneficiary.require_auth();

        if grant_ids.is_empty() {
            return Ok(0);
        }

        if grant_ids.len() > MAX_BATCH_CLAIMS {
            return Err(VestingError::BatchTooLarge);
        }

        let mut schedules = load_schedules(&env)?;
        let token: Address = env
            .storage()
            .persistent()
            .get(&symbol_short!("token"))
            .ok_or(VestingError::Unauthorized)?;
        let token_client = soroban_sdk::token::Client::new(&env, &token);
        let current_balance = token_client.balance(&env.current_contract_address());
        let current_time = env.ledger().timestamp();

        let mut total_claimable = 0i128;
        let mut updated_schedules = Vec::new(&env);

        for grant_id in grant_ids.iter() {
            let mut schedule = schedules.get(grant_id).ok_or(VestingError::GrantNotFound)?;
            let claim_amount = claimable_amount(&env, grant_id, &beneficiary, &schedule)?;

            total_claimable += claim_amount;
            schedule.claimed = true;
            updated_schedules.push_back((grant_id, schedule, claim_amount));
        }

        if current_balance < total_claimable {
            return Err(VestingError::InsufficientBalance);
        }

        for (grant_id, schedule, claim_amount) in updated_schedules.iter() {
            schedules.set(grant_id, schedule);
            token_client.transfer(&env.current_contract_address(), &beneficiary, &claim_amount);

            env.events().publish(
                (symbol_short!("claim"),),
                ClaimEvent {
                    grant_id,
                    beneficiary: beneficiary.clone(),
                    amount: claim_amount,
                    claimed_at: current_time,
                },
            );

            env.events().publish(
                (symbol_short!("v_claimed"),),
                VestingClaimed {
                    grant_id,
                    beneficiary: beneficiary.clone(),
                    amount: claim_amount,
                    claimed_at: current_time,
                },
            );
        }

        persist_schedules(&env, &schedules);

        Ok(total_claimable)
    }

    /// Revoke a vesting schedule (governance/admin only, with timelock)
    pub fn revoke(
        env: Env,
        grant_id: u64,
        admin: Address,
        revoke_delay: u64,
    ) -> Result<(), VestingError> {
        admin.require_auth();

        // Check pause state via CircuitBreaker
        CircuitBreaker::require_not_paused(&env, symbol_short!("revoke"));

        // Verify caller is admin
        let admin_key = symbol_short!("admin");
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&admin_key)
            .ok_or(VestingError::Unauthorized)?;

        if admin != stored_admin {
            // Audit: record the denied attempt before failing
            EventEmitter::access_denied(
                &env,
                AccessDeniedEvent {
                    actor: admin,
                    required_permission: symbol_short!("admin"),
                    resource: symbol_short!("revoke"),
                    timestamp: env.ledger().timestamp(),
                },
            );
            return Err(VestingError::Unauthorized);
        }

        // Get vesting schedule
        let mut schedules = load_schedules(&env)?;

        let mut schedule = schedules.get(grant_id).ok_or(VestingError::GrantNotFound)?;

        // Cannot revoke already claimed
        if schedule.claimed {
            return Err(VestingError::AlreadyClaimed);
        }

        // Cannot revoke already revoked
        if schedule.revoked {
            return Err(VestingError::Revoked);
        }

        // Enforce timelock for revocation (minimum 1 hour)
        if revoke_delay < 3600 {
            return Err(VestingError::InvalidTimelock);
        }

        // Check if enough time has passed since grant to allow revocation
        let current_time = env.ledger().timestamp();
        if current_time < schedule.start_time + revoke_delay {
            return Err(VestingError::NotEnoughTimeForRevoke);
        }

        // Mark as revoked
        schedule.revoked = true;
        schedule.revoke_time = current_time;
        schedules.set(grant_id, schedule.clone());
        persist_schedules(&env, &schedules);

        // Emit revoke event
        let revoke_event = RevokeEvent {
            grant_id,
            beneficiary: schedule.beneficiary,
            revoked_at: current_time,
            revoked_by: admin.clone(),
        };

        env.events()
            .publish((symbol_short!("revoke"),), revoke_event);

        // Audit: standardized admin-mutation event alongside the domain event above
        EventEmitter::audit_action(
            &env,
            AuditActionEvent {
                actor: admin,
                operation: symbol_short!("revoke"),
                old_value: symbol_short!("active"),
                new_value: symbol_short!("revoked"),
                correlation_id: symbol_short!("revoke"),
                timestamp: current_time,
            },
        );

        Ok(())
    }

    /// Query vesting schedule details
    pub fn get_vesting(env: Env, grant_id: u64) -> Result<VestingSchedule, VestingError> {
        let schedules = load_schedules(&env)?;

        schedules.get(grant_id).ok_or(VestingError::GrantNotFound)
    }

    /// Calculate vested amount at current time
    pub fn get_vested_amount(env: Env, grant_id: u64) -> Result<i128, VestingError> {
        let schedules = load_schedules(&env)?;

        let schedule = schedules.get(grant_id).ok_or(VestingError::GrantNotFound)?;

        let current_time = env.ledger().timestamp();
        Self::calculate_vested_amount(&schedule, current_time)
    }

    /// Internal helper: calculate vested amount based on schedule and current time
    fn calculate_vested_amount(
        schedule: &VestingSchedule,
        current_time: u64,
    ) -> Result<i128, VestingError> {
        // If not started yet
        if current_time < schedule.start_time {
            return Ok(0);
        }

        // If cliff hasn't passed
        if current_time < schedule.start_time + schedule.cliff {
            return Ok(0);
        }

        // If fully vested
        if current_time >= schedule.start_time + schedule.duration {
            return Ok(schedule.amount);
        }

        // Partial vesting (linear vesting after cliff)
        let vested_duration = current_time - (schedule.start_time + schedule.cliff);
        let remaining_duration = schedule.duration - schedule.cliff;

        if remaining_duration == 0 {
            return Ok(schedule.amount);
        }

        // Use fixed-point arithmetic to avoid floating point
        let vested_amount =
            (schedule.amount as u128 * vested_duration as u128) / remaining_duration as u128;

        Ok(vested_amount as i128)
    }

    /// Get contract information
    pub fn get_info(env: Env) -> Result<(Address, Address, Address), VestingError> {
        let admin_key = symbol_short!("admin");
        let token_key = symbol_short!("token");
        let gov_key = symbol_short!("gov");

        let admin = env
            .storage()
            .persistent()
            .get(&admin_key)
            .ok_or(VestingError::Unauthorized)?;

        let token = env
            .storage()
            .persistent()
            .get(&token_key)
            .ok_or(VestingError::Unauthorized)?;

        let governance = env
            .storage()
            .persistent()
            .get(&gov_key)
            .ok_or(VestingError::Unauthorized)?;

        Ok((admin, token, governance))
    }

    pub fn max_batch_claims() -> u32 {
        MAX_BATCH_CLAIMS
    }
}