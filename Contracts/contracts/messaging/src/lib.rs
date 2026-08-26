#![no_std]

use shared::acl::{ACL, ROLE_ADMIN, PERMISSION_PAUSE, PERMISSION_UNPAUSE, PERMISSION_SET_RATE, PERMISSION_PREMIUM, PERMISSION_MGR_ACL};
use shared::circuit_breaker::{
    CircuitBreaker, CircuitBreakerConfig, CircuitBreakerState, PauseLevel,
};
use shared::events::{AccessDeniedEvent, AuditActionEvent, EventEmitter};
use shared::governance::{GovernanceManager, UpgradeProposal};
use shared::nonce::NonceManager;
use shared::reentrancy_guard::ReentrancyGuard;
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env, Map, String,
    Symbol, Vec, xdr::ToXdr,
};

const CONTRACT_VERSION: u32 = 1;
const MAX_MESSAGE_LENGTH: u32 = 1024;

const RL_CFG: Symbol = symbol_short!("rl_cfg");
const PREM: Symbol = symbol_short!("prem");

#[contract]
pub struct UpgradeableMessagingContract;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Message {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub payload: String,
    pub timestamp: u64,
    pub read: bool,
    pub processed: bool,
    pub nonce: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageHashRecord {
    pub message_id: u64,
    pub hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessagingStats {
    pub total_messages: u64,
    pub unread_messages: u64,
    pub last_message_id: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RateLimitConfig {
    pub window_secs: u64,
    pub user_limit: u32,
    pub global_limit: u32,
    pub premium_user_limit: u32,
}

/// Event emitted when a message is sent
#[contracttype]
#[derive(Clone, Debug)]
pub struct MessageSent {
    pub message_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub timestamp: u64,
    pub payload_length: u32,
}

/// Event emitted when a message is marked as read
#[contracttype]
#[derive(Clone, Debug)]
pub struct MessageRead {
    pub message_id: u64,
    pub recipient: Address,
    pub sender: Address,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EncryptedMessage {
    pub id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub payload: Bytes,
    pub timestamp: u64,
    pub read: bool,
    pub processed: bool,
    pub nonce: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct EncryptedMessageSent {
    pub message_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub timestamp: u64,
    pub payload_length: u32,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MessagingError {
    Unauthorized = 4001,
    InvalidPayload = 4002,
    InvalidRecipient = 4003,
    MessageNotFound = 4004,
    AlreadyRead = 4005,
    NotInitialized = 4006,
    RateLimitExceeded = 4007,
    GlobalRateLimitExceeded = 4008,
    InvalidRateLimitConfig = 4009,
}

impl From<MessagingError> for soroban_sdk::Error {
    fn from(error: MessagingError) -> Self {
        soroban_sdk::Error::from_contract_error(error as u32)
    }
}

impl From<&MessagingError> for soroban_sdk::Error {
    fn from(error: &MessagingError) -> Self {
        soroban_sdk::Error::from_contract_error(*error as u32)
    }
}

impl From<soroban_sdk::Error> for MessagingError {
    fn from(_error: soroban_sdk::Error) -> Self {
        MessagingError::Unauthorized
    }
}

fn require_initialized(env: &Env) -> Result<(), MessagingError> {
    let init_key = symbol_short!("init");
    if env.storage().persistent().has(&init_key) {
        Ok(())
    } else {
        Err(MessagingError::NotInitialized)
    }
}

fn get_messages_map(env: &Env) -> Map<u64, Message> {
    env.storage()
        .persistent()
        .get(&symbol_short!("msgs"))
        .unwrap_or_else(|| Map::new(env))
}

fn get_encrypted_messages_map(env: &Env) -> Map<u64, EncryptedMessage> {
    env.storage()
        .persistent()
        .get(&symbol_short!("enc_msgs"))
        .unwrap_or_else(|| Map::new(env))
}

fn get_user_message_ids(env: &Env, key: &Symbol, user: &Address) -> Vec<u64> {
    let message_index: Map<Address, Vec<u64>> = env
        .storage()
        .persistent()
        .get(key)
        .unwrap_or_else(|| Map::new(env));

    message_index
        .get(user.clone())
        .unwrap_or_else(|| Vec::new(env))
}

fn set_user_message_ids(env: &Env, key: &Symbol, user: &Address, ids: Vec<u64>) {
    let mut message_index: Map<Address, Vec<u64>> = env
        .storage()
        .persistent()
        .get(key)
        .unwrap_or_else(|| Map::new(env));

    message_index.set(user.clone(), ids);
    env.storage().persistent().set(key, &message_index);
}

fn get_unread_counts(env: &Env) -> Map<Address, u32> {
    env.storage()
        .persistent()
        .get(&symbol_short!("unread"))
        .unwrap_or_else(|| Map::new(env))
}

fn get_stats_internal(env: &Env) -> MessagingStats {
    env.storage()
        .persistent()
        .get(&symbol_short!("stats"))
        .unwrap_or(MessagingStats {
            total_messages: 0,
            unread_messages: 0,
            last_message_id: 0,
        })
}

fn read_rate_limit_config(env: &Env) -> RateLimitConfig {
    env.storage()
        .persistent()
        .get(&RL_CFG)
        .unwrap_or(RateLimitConfig {
            window_secs: 60,
            user_limit: 5,
            global_limit: 100,
            premium_user_limit: 20,
        })
}

fn is_premium_user(env: &Env, user: &Address) -> bool {
    let premium_users: Map<Address, bool> = env
        .storage()
        .persistent()
        .get(&PREM)
        .unwrap_or_else(|| Map::new(env));

    premium_users.get(user.clone()).unwrap_or(false)
}

fn get_user_window_usage(env: &Env, user: &Address, window: u64) -> u32 {
    let key = (symbol_short!("rlu"), user.clone(), window);
    env.storage().persistent().get(&key).unwrap_or(0)
}

fn set_user_window_usage(env: &Env, user: &Address, window: u64, count: u32) {
    let key = (symbol_short!("rlu"), user.clone(), window);
    env.storage().persistent().set(&key, &count);
}

fn get_global_window_usage(env: &Env, window: u64) -> u32 {
    let key = (symbol_short!("rlg"), window);
    env.storage().persistent().get(&key).unwrap_or(0)
}

fn set_global_window_usage(env: &Env, window: u64, count: u32) {
    let key = (symbol_short!("rlg"), window);
    env.storage().persistent().set(&key, &count);
}

fn compute_message_hash(env: &Env, sender: &Address, recipient: &Address, payload: &String, nonce: u64) -> BytesN<32> {
    let mut data = Bytes::new(env);
    data.append(&sender.clone().to_xdr(env));
    data.append(&recipient.clone().to_xdr(env));
    data.append(&payload.clone().to_xdr(env));
    data.append(&nonce.to_xdr(env));
    env.crypto().sha256(&data).into()
}

fn check_and_consume_message_rate_limit(env: &Env, sender: &Address) -> Result<(), MessagingError> {
    let cfg = read_rate_limit_config(env);

    if cfg.window_secs == 0
        || cfg.user_limit == 0
        || cfg.global_limit == 0
        || cfg.premium_user_limit == 0
    {
        return Err(MessagingError::InvalidRateLimitConfig);
    }

    let now = env.ledger().timestamp();
    let window = now / cfg.window_secs;

    let current_user = get_user_window_usage(env, sender, window);
    let current_global = get_global_window_usage(env, window);

    let allowed_user_limit = if is_premium_user(env, sender) {
        cfg.premium_user_limit
    } else {
        cfg.user_limit
    };

    if current_user >= allowed_user_limit {
        return Err(MessagingError::RateLimitExceeded);
    }

    if current_global >= cfg.global_limit {
        return Err(MessagingError::GlobalRateLimitExceeded);
    }

    set_user_window_usage(env, sender, window, current_user.saturating_add(1));
    set_global_window_usage(env, window, current_global.saturating_add(1));

    Ok(())
}

#[contractimpl]
impl UpgradeableMessagingContract {
    pub fn init(
        env: Env,
        admin: Address,
        approvers: Vec<Address>,
        executor: Address,
        cb_config: CircuitBreakerConfig,
    ) -> Result<(), MessagingError> {
        let init_key = symbol_short!("init");
        if env.storage().persistent().has(&init_key) {
            return Err(MessagingError::Unauthorized);
        }

        env.storage().persistent().set(&init_key, &true);

        GovernanceManager::init_governance_roles(&env, admin.clone(), approvers.clone(), executor.clone());

        // Assign additional permissions to admin role
        ACL::assign_permission(&env, &ROLE_ADMIN, &PERMISSION_SET_RATE);
        ACL::assign_permission(&env, &ROLE_ADMIN, &PERMISSION_PREMIUM);
        ACL::assign_permission(&env, &ROLE_ADMIN, &PERMISSION_PAUSE);
        ACL::assign_permission(&env, &ROLE_ADMIN, &PERMISSION_UNPAUSE);
        ACL::assign_permission(&env, &ROLE_ADMIN, &PERMISSION_MGR_ACL);

        env.storage().persistent().set(
            &symbol_short!("stats"),
            &MessagingStats {
                total_messages: 0,
                unread_messages: 0,
                last_message_id: 0,
            },
        );

        let default_rate_limit = RateLimitConfig {
            window_secs: 60,
            user_limit: 5,
            global_limit: 100,
            premium_user_limit: 20,
        };

        let premium_users = Map::<Address, bool>::new(&env);

        env.storage().persistent().set(&RL_CFG, &default_rate_limit);
        env.storage().persistent().set(&PREM, &premium_users);

        env.storage()
            .persistent()
            .set(&symbol_short!("ver"), &CONTRACT_VERSION);

        env.storage().persistent().set(&symbol_short!("src_chain"), &0u32);

        NonceManager::set_chain_id(&env, 0);

        // Initialize circuit breaker
        CircuitBreaker::init(&env, cb_config);

        Ok(())
    }

    pub fn send_message(
        env: Env,
        sender: Address,
        recipient: Address,
        payload: String,
    ) -> Result<u64, MessagingError> {
        sender.require_auth();
        require_initialized(&env)?;
        check_and_consume_message_rate_limit(&env, &sender)?;

        CircuitBreaker::require_not_paused(&env, symbol_short!("send_m"));
        ReentrancyGuard::enter(&env);
        NonceManager::enforce_sequential_nonce(&env, 0, env.ledger().sequence() as u64);
        let _ = NonceManager::record_and_verify(&env, 0, env.ledger().sequence() as u64);

        CircuitBreaker::track_activity(&env, 1);

        if sender == recipient {
            ReentrancyGuard::exit(&env);
            return Err(MessagingError::InvalidRecipient);
        }

        let payload_len = payload.len();
        if payload_len == 0 || payload_len > MAX_MESSAGE_LENGTH {
            ReentrancyGuard::exit(&env);
            return Err(MessagingError::InvalidPayload);
        }

        let mut stats = get_stats_internal(&env);
        let message_id = stats.last_message_id + 1;

        let current_timestamp = env.ledger().timestamp();
        let nonce = env.ledger().sequence() as u64;

        let message = Message {
            id: message_id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            payload: payload.clone(),
            timestamp: current_timestamp,
            read: false,
            processed: true,
            nonce,
        };

        let message_hash = compute_message_hash(&env, &sender, &recipient, &payload, nonce);
        let hash_record = MessageHashRecord {
            message_id,
            hash: message_hash,
        };
        let mut hash_store: Map<BytesN<32>, MessageHashRecord> = env
            .storage()
            .persistent()
            .get(&symbol_short!("msg_hash"))
            .unwrap_or_else(|| Map::new(&env));
        hash_store.set(hash_record.hash.clone(), hash_record);
        env.storage()
            .persistent()
            .set(&symbol_short!("msg_hash"), &hash_store);

        let mut messages = get_messages_map(&env);
        messages.set(message_id, message);
        env.storage()
            .persistent()
            .set(&symbol_short!("msgs"), &messages);

        let inbox_key = symbol_short!("inbox");
        let sent_key = symbol_short!("sent");

        let mut recipient_ids = get_user_message_ids(&env, &inbox_key, &recipient);
        recipient_ids.push_back(message_id);
        set_user_message_ids(&env, &inbox_key, &recipient, recipient_ids);

        let mut sender_ids = get_user_message_ids(&env, &sent_key, &sender);
        sender_ids.push_back(message_id);
        set_user_message_ids(&env, &sent_key, &sender, sender_ids);

        let mut unread_counts = get_unread_counts(&env);
        let unread_count = unread_counts.get(recipient.clone()).unwrap_or(0);
        unread_counts.set(recipient.clone(), unread_count + 1);
        env.storage()
            .persistent()
            .set(&symbol_short!("unread"), &unread_counts);

        stats.total_messages += 1;
        stats.unread_messages += 1;
        stats.last_message_id = message_id;
        env.storage()
            .persistent()
            .set(&symbol_short!("stats"), &stats);

        let message_sent_event = MessageSent {
            message_id,
            sender: sender.clone(),
            recipient,
            timestamp: current_timestamp,
            payload_length: payload_len as u32,
        };

        env.events()
            .publish((symbol_short!("msg_sent"),), message_sent_event);

        ReentrancyGuard::exit(&env);
        Ok(message_id)
    }

    pub fn mark_as_read(
        env: Env,
        recipient: Address,
        message_id: u64,
    ) -> Result<(), MessagingError> {
        recipient.require_auth();
        require_initialized(&env)?;

        let mut messages = get_messages_map(&env);
        let mut message = messages
            .get(message_id)
            .ok_or(MessagingError::MessageNotFound)?;

        if message.recipient != recipient {
            return Err(MessagingError::Unauthorized);
        }

        if message.read {
            return Err(MessagingError::AlreadyRead);
        }

        ReentrancyGuard::enter(&env);

        let current_timestamp = env.ledger().timestamp();

        message.read = true;
        messages.set(message_id, message.clone());
        env.storage()
            .persistent()
            .set(&symbol_short!("msgs"), &messages);

        let mut unread_counts = get_unread_counts(&env);
        let unread_count = unread_counts.get(recipient.clone()).unwrap_or(0);
        unread_counts.set(recipient.clone(), unread_count.saturating_sub(1));
        env.storage()
            .persistent()
            .set(&symbol_short!("unread"), &unread_counts);

        let mut stats = get_stats_internal(&env);
        stats.unread_messages = stats.unread_messages.saturating_sub(1);
        env.storage()
            .persistent()
            .set(&symbol_short!("stats"), &stats);

        let message_read_event = MessageRead {
            message_id,
            recipient,
            sender: message.sender,
            timestamp: current_timestamp,
        };

        env.events()
            .publish((symbol_short!("msg_read"),), message_read_event);

        ReentrancyGuard::exit(&env);
        Ok(())
    }

    pub fn get_messages(
        env: Env,
        user: Address,
        include_sent: bool,
        include_received: bool,
        unread_only: bool,
    ) -> Result<Vec<Message>, MessagingError> {
        user.require_auth();
        require_initialized(&env)?;

        let messages = get_messages_map(&env);
        let mut result = Vec::new(&env);

        if include_received {
            let inbox_key = symbol_short!("inbox");
            let inbox_ids = get_user_message_ids(&env, &inbox_key, &user);
            for message_id in inbox_ids.iter() {
                if let Some(message) = messages.get(message_id) {
                    if !unread_only || !message.read {
                        result.push_back(message);
                    }
                }
            }
        }

        if include_sent {
            let sent_key = symbol_short!("sent");
            let sent_ids = get_user_message_ids(&env, &sent_key, &user);
            for message_id in sent_ids.iter() {
                if let Some(message) = messages.get(message_id) {
                    if !unread_only || !message.read {
                        result.push_back(message);
                    }
                }
            }
        }

        Ok(result)
    }

    pub fn get_unread_count(env: Env, user: Address) -> Result<u32, MessagingError> {
        user.require_auth();
        require_initialized(&env)?;
        let unread_counts = get_unread_counts(&env);
        Ok(unread_counts.get(user).unwrap_or(0))
    }

    pub fn set_cb_pause_level(
        env: Env,
        admin: Address,
        level: PauseLevel,
    ) -> Result<(), MessagingError> {
        admin.require_auth();

        if !ACL::has_permission(&env, &admin, &PERMISSION_PAUSE) {
            EventEmitter::access_denied(
                &env,
                AccessDeniedEvent {
                    actor: admin.clone(),
                    required_permission: PERMISSION_PAUSE,
                    resource: symbol_short!("cb_level"),
                    timestamp: env.ledger().timestamp(),
                },
            );
        }
        ACL::require_permission(&env, &admin, &PERMISSION_PAUSE);

        CircuitBreaker::set_pause_level(&env, admin.clone(), level);

        EventEmitter::audit_action(
            &env,
            AuditActionEvent {
                actor: admin,
                operation: symbol_short!("cb_level"),
                old_value: symbol_short!("unknown"),
                new_value: symbol_short!("set"),
                correlation_id: symbol_short!("cb_level"),
                timestamp: env.ledger().timestamp(),
            },
        );

        Ok(())
    }

    pub fn pause_cb_function(
        env: Env,
        admin: Address,
        func_name: Symbol,
    ) -> Result<(), MessagingError> {
        admin.require_auth();

        if !ACL::has_permission(&env, &admin, &PERMISSION_PAUSE) {
            EventEmitter::access_denied(
                &env,
                AccessDeniedEvent {
                    actor: admin.clone(),
                    required_permission: PERMISSION_PAUSE,
                    resource: symbol_short!("pause_fn"),
                    timestamp: env.ledger().timestamp(),
                },
            );
        }
        ACL::require_permission(&env, &admin, &PERMISSION_PAUSE);

        CircuitBreaker::pause_function(&env, admin.clone(), func_name);

        EventEmitter::audit_action(
            &env,
            AuditActionEvent {
                actor: admin,
                operation: symbol_short!("pause_fn"),
                old_value: symbol_short!("active"),
                new_value: symbol_short!("paused"),
                correlation_id: symbol_short!("pause_fn"),
                timestamp: env.ledger().timestamp(),
            },
        );

        Ok(())
    }

    pub fn unpause_cb_function(
        env: Env,
        admin: Address,
        func_name: Symbol,
    ) -> Result<(), MessagingError> {
        admin.require_auth();

        if !ACL::has_permission(&env, &admin, &PERMISSION_UNPAUSE) {
            EventEmitter::access_denied(
                &env,
                AccessDeniedEvent {
                    actor: admin.clone(),
                    required_permission: PERMISSION_UNPAUSE,
                    resource: symbol_short!("unpause"),
                    timestamp: env.ledger().timestamp(),
                },
            );
        }
        ACL::require_permission(&env, &admin, &PERMISSION_UNPAUSE);

        CircuitBreaker::unpause_function(&env, admin.clone(), func_name);

        EventEmitter::audit_action(
            &env,
            AuditActionEvent {
                actor: admin,
                operation: symbol_short!("unpause"),
                old_value: symbol_short!("paused"),
                new_value: symbol_short!("active"),
                correlation_id: symbol_short!("unpause"),
                timestamp: env.ledger().timestamp(),
            },
        );

        Ok(())
    }

    pub fn get_cb_state(env: Env) -> CircuitBreakerState {
        CircuitBreaker::get_state(&env)
    }

    pub fn get_cb_config(env: Env) -> CircuitBreakerConfig {
        CircuitBreaker::get_config(&env)
    }

    pub fn get_stats(env: Env) -> MessagingStats {
        get_stats_internal(&env)
    }

    pub fn get_version(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&symbol_short!("ver"))
            .unwrap_or(0)
    }

    pub fn compute_message_hash_public(
        env: Env,
        sender: Address,
        recipient: Address,
        payload: String,
        nonce: u64,
    ) -> BytesN<32> {
        compute_message_hash(&env, &sender, &recipient, &payload, nonce)
    }

    pub fn set_rate_limit_config(
        env: Env,
        admin: Address,
        window_secs: u64,
        user_limit: u32,
        global_limit: u32,
        premium_user_limit: u32,
    ) -> Result<(), MessagingError> {
        admin.require_auth();
        require_initialized(&env)?;

        if !ACL::has_permission(&env, &admin, &PERMISSION_SET_RATE) {
            EventEmitter::access_denied(
                &env,
                AccessDeniedEvent {
                    actor: admin.clone(),
                    required_permission: PERMISSION_SET_RATE,
                    resource: symbol_short!("rate_cfg"),
                    timestamp: env.ledger().timestamp(),
                },
            );
        }
        ACL::require_permission(&env, &admin, &PERMISSION_SET_RATE);

        if window_secs == 0 || user_limit == 0 || global_limit == 0 || premium_user_limit == 0 {
            return Err(MessagingError::InvalidRateLimitConfig);
        }

        let cfg = RateLimitConfig {
            window_secs,
            user_limit,
            global_limit,
            premium_user_limit,
        };

        env.storage().persistent().set(&RL_CFG, &cfg);

        EventEmitter::audit_action(
            &env,
            AuditActionEvent {
                actor: admin,
                operation: symbol_short!("rate_cfg"),
                old_value: symbol_short!("prior"),
                new_value: symbol_short!("updated"),
                correlation_id: symbol_short!("rate_cfg"),
                timestamp: env.ledger().timestamp(),
            },
        );

        Ok(())
    }

    pub fn set_premium_user(
        env: Env,
        admin: Address,
        user: Address,
        is_premium: bool,
    ) -> Result<(), MessagingError> {
        admin.require_auth();
        require_initialized(&env)?;

        if !ACL::has_permission(&env, &admin, &PERMISSION_PREMIUM) {
            EventEmitter::access_denied(
                &env,
                AccessDeniedEvent {
                    actor: admin.clone(),
                    required_permission: PERMISSION_PREMIUM,
                    resource: symbol_short!("premium"),
                    timestamp: env.ledger().timestamp(),
                },
            );
        }
        ACL::require_permission(&env, &admin, &PERMISSION_PREMIUM);

        let mut premium_users: Map<Address, bool> = env
            .storage()
            .persistent()
            .get(&PREM)
            .unwrap_or_else(|| Map::new(&env));

        let was_premium = premium_users.get(user.clone()).unwrap_or(false);
        premium_users.set(user, is_premium);
        env.storage().persistent().set(&PREM, &premium_users);

        EventEmitter::audit_action(
            &env,
            AuditActionEvent {
                actor: admin,
                operation: symbol_short!("premium"),
                old_value: if was_premium {
                    symbol_short!("true")
                } else {
                    symbol_short!("false")
                },
                new_value: if is_premium {
                    symbol_short!("true")
                } else {
                    symbol_short!("false")
                },
                correlation_id: symbol_short!("premium"),
                timestamp: env.ledger().timestamp(),
            },
        );

        Ok(())
    }

    pub fn get_rate_limit_config(env: Env) -> Result<RateLimitConfig, MessagingError> {
        require_initialized(&env)?;
        Ok(read_rate_limit_config(&env))
    }

    pub fn create_role(env: Env, admin: Address, role: Symbol) -> Result<(), MessagingError> {
        admin.require_auth();
        require_initialized(&env)?;

        if !ACL::has_permission(&env, &admin, &PERMISSION_MGR_ACL) {
            EventEmitter::access_denied(
                &env,
                AccessDeniedEvent {
                    actor: admin.clone(),
                    required_permission: PERMISSION_MGR_ACL,
                    resource: symbol_short!("cr_role"),
                    timestamp: env.ledger().timestamp(),
                },
            );
        }
        ACL::require_permission(&env, &admin, &PERMISSION_MGR_ACL);

        ACL::create_role(&env, &role);

        EventEmitter::audit_action(
            &env,
            AuditActionEvent {
                actor: admin,
                operation: symbol_short!("cr_role"),
                old_value: symbol_short!("none"),
                new_value: role,
                correlation_id: symbol_short!("cr_role"),
                timestamp: env.ledger().timestamp(),
            },
        );

        Ok(())
    }

    pub fn assign_role(
        env: Env,
        admin: Address,
        user: Address,
        role: Symbol,
    ) -> Result<(), MessagingError> {
        admin.require_auth();
        require_initialized(&env)?;

        if !ACL::has_permission(&env, &admin, &PERMISSION_MGR_ACL) {
            EventEmitter::access_denied(
                &env,
                AccessDeniedEvent {
                    actor: admin.clone(),
                    required_permission: PERMISSION_MGR_ACL,
                    resource: symbol_short!("asn_role"),
                    timestamp: env.ledger().timestamp(),
                },
            );
        }
        ACL::require_permission(&env, &admin, &PERMISSION_MGR_ACL);

        ACL::assign_role(&env, &user, &role);

        EventEmitter::audit_action(
            &env,
            AuditActionEvent {
                actor: admin,
                operation: symbol_short!("asn_role"),
                old_value: symbol_short!("none"),
                new_value: role,
                correlation_id: symbol_short!("asn_role"),
                timestamp: env.ledger().timestamp(),
            },
        );

        Ok(())
    }

    pub fn assign_permission(
        env: Env,
        admin: Address,
        role: Symbol,
        permission: Symbol,
    ) -> Result<(), MessagingError> {
        admin.require_auth();
        require_initialized(&env)?;

        if !ACL::has_permission(&env, &admin, &PERMISSION_MGR_ACL) {
            EventEmitter::access_denied(
                &env,
                AccessDeniedEvent {
                    actor: admin.clone(),
                    required_permission: PERMISSION_MGR_ACL,
                    resource: symbol_short!("asn_perm"),
                    timestamp: env.ledger().timestamp(),
                },
            );
        }
        ACL::require_permission(&env, &admin, &PERMISSION_MGR_ACL);

        ACL::assign_permission(&env, &role, &permission);

        EventEmitter::audit_action(
            &env,
            AuditActionEvent {
                actor: admin,
                operation: symbol_short!("asn_perm"),
                old_value: role,
                new_value: permission,
                correlation_id: symbol_short!("asn_perm"),
                timestamp: env.ledger().timestamp(),
            },
        );

        Ok(())
    }

    pub fn assign_permissions_batch(
        env: Env,
        admin: Address,
        role: Symbol,
        permissions: Vec<Symbol>,
    ) -> Result<(), MessagingError> {
        admin.require_auth();
        require_initialized(&env)?;

        if !ACL::has_permission(&env, &admin, &PERMISSION_MGR_ACL) {
            EventEmitter::access_denied(
                &env,
                AccessDeniedEvent {
                    actor: admin.clone(),
                    required_permission: PERMISSION_MGR_ACL,
                    resource: symbol_short!("asn_permb"),
                    timestamp: env.ledger().timestamp(),
                },
            );
        }
        ACL::require_permission(&env, &admin, &PERMISSION_MGR_ACL);

        ACL::assign_permissions_batch(&env, &role, &permissions);

        EventEmitter::audit_action(
            &env,
            AuditActionEvent {
                actor: admin,
                operation: symbol_short!("asn_permb"),
                old_value: role,
                new_value: symbol_short!("batch"),
                correlation_id: symbol_short!("asn_permb"),
                timestamp: env.ledger().timestamp(),
            },
        );

        Ok(())
    }

    pub fn set_role_parent(
        env: Env,
        admin: Address,
        child: Symbol,
        parent: Symbol,
    ) -> Result<(), MessagingError> {
        admin.require_auth();
        require_initialized(&env)?;

        if !ACL::has_permission(&env, &admin, &PERMISSION_MGR_ACL) {
            EventEmitter::access_denied(
                &env,
                AccessDeniedEvent {
                    actor: admin.clone(),
                    required_permission: PERMISSION_MGR_ACL,
                    resource: symbol_short!("role_par"),
                    timestamp: env.ledger().timestamp(),
                },
            );
        }
        ACL::require_permission(&env, &admin, &PERMISSION_MGR_ACL);

        ACL::set_parent_role(&env, &child, &parent);

        EventEmitter::audit_action(
            &env,
            AuditActionEvent {
                actor: admin,
                operation: symbol_short!("role_par"),
                old_value: child,
                new_value: parent,
                correlation_id: symbol_short!("role_par"),
                timestamp: env.ledger().timestamp(),
            },
        );

        Ok(())
    }

    pub fn get_user_roles(env: Env, user: Address) -> Result<Vec<Symbol>, MessagingError> {
        require_initialized(&env)?;
        Ok(ACL::get_user_roles(&env, &user))
    }

    pub fn get_role_permissions(env: Env, role: Symbol) -> Result<Vec<Symbol>, MessagingError> {
        require_initialized(&env)?;
        Ok(ACL::get_role_permissions(&env, &role))
    }

    pub fn has_permission(
        env: Env,
        user: Address,
        permission: Symbol,
    ) -> Result<bool, MessagingError> {
        require_initialized(&env)?;
        Ok(ACL::has_permission(&env, &user, &permission))
    }

    #[allow(dead_code)]
    fn require_admin_role(env: &Env, admin: &Address) -> Result<(), MessagingError> {
        // Check if the user has the admin role via ACL
        let user_roles = ACL::get_user_roles(env, admin);
        if !user_roles.iter().any(|r| r == ROLE_ADMIN) {
            return Err(MessagingError::Unauthorized);
        }

        Ok(())
    }

    pub fn propose_upgrade(
        env: Env,
        admin: Address,
        new_contract_hash: Symbol,
        description: Symbol,
        approvers: Vec<Address>,
        approval_threshold: u32,
        timelock_delay: u64,
    ) -> Result<u64, MessagingError> {
        admin.require_auth();
        require_initialized(&env)?;

        let result = GovernanceManager::propose_upgrade(
            &env,
            admin.clone(),
            new_contract_hash,
            env.current_contract_address(),
            description,
            approval_threshold,
            approvers,
            timelock_delay,
        )
        .map_err(|_| MessagingError::Unauthorized);

        if result.is_ok() {
            EventEmitter::audit_action(
                &env,
                AuditActionEvent {
                    actor: admin,
                    operation: symbol_short!("propose"),
                    old_value: symbol_short!("none"),
                    new_value: symbol_short!("pending"),
                    correlation_id: symbol_short!("propose"),
                    timestamp: env.ledger().timestamp(),
                },
            );
        }

        result
    }

    pub fn approve_upgrade(
        env: Env,
        proposal_id: u64,
        approver: Address,
    ) -> Result<(), MessagingError> {
        approver.require_auth();
        require_initialized(&env)?;

        let result = GovernanceManager::approve_proposal(&env, proposal_id, approver.clone())
            .map_err(|_| MessagingError::Unauthorized);

        if result.is_ok() {
            EventEmitter::audit_action(
                &env,
                AuditActionEvent {
                    actor: approver,
                    operation: symbol_short!("approve"),
                    old_value: symbol_short!("pending"),
                    new_value: symbol_short!("approved"),
                    correlation_id: symbol_short!("approve"),
                    timestamp: env.ledger().timestamp(),
                },
            );
        }

        result
    }

    pub fn execute_upgrade(
        env: Env,
        proposal_id: u64,
        executor: Address,
    ) -> Result<(), MessagingError> {
        executor.require_auth();
        require_initialized(&env)?;

        let result = GovernanceManager::execute_proposal(&env, proposal_id, executor.clone())
            .map_err(|_| MessagingError::Unauthorized);

        if result.is_ok() {
            EventEmitter::audit_action(
                &env,
                AuditActionEvent {
                    actor: executor,
                    operation: symbol_short!("execute"),
                    old_value: symbol_short!("approved"),
                    new_value: symbol_short!("executed"),
                    correlation_id: symbol_short!("execute"),
                    timestamp: env.ledger().timestamp(),
                },
            );
        }

        result
    }

    pub fn get_upgrade_proposal(
        env: Env,
        proposal_id: u64,
    ) -> Result<UpgradeProposal, MessagingError> {
        require_initialized(&env)?;
        GovernanceManager::get_proposal(&env, proposal_id).map_err(|_| MessagingError::Unauthorized)
    }

    pub fn reject_upgrade(
        env: Env,
        proposal_id: u64,
        rejector: Address,
    ) -> Result<(), MessagingError> {
        rejector.require_auth();
        require_initialized(&env)?;

        let result = GovernanceManager::reject_proposal(&env, proposal_id, rejector.clone())
            .map_err(|_| MessagingError::Unauthorized);

        if result.is_ok() {
            EventEmitter::audit_action(
                &env,
                AuditActionEvent {
                    actor: rejector,
                    operation: symbol_short!("reject"),
                    old_value: symbol_short!("pending"),
                    new_value: symbol_short!("rejected"),
                    correlation_id: symbol_short!("reject"),
                    timestamp: env.ledger().timestamp(),
                },
            );
        }

        result
    }

    pub fn cancel_upgrade(
        env: Env,
        proposal_id: u64,
        admin: Address,
    ) -> Result<(), MessagingError> {
        admin.require_auth();
        require_initialized(&env)?;

        let result = GovernanceManager::cancel_proposal(&env, proposal_id, admin.clone())
            .map_err(|_| MessagingError::Unauthorized);

        if result.is_ok() {
            EventEmitter::audit_action(
                &env,
                AuditActionEvent {
                    actor: admin,
                    operation: symbol_short!("cancel"),
                    old_value: symbol_short!("pending"),
                    new_value: symbol_short!("canceled"),
                    correlation_id: symbol_short!("cancel"),
                    timestamp: env.ledger().timestamp(),
                },
            );
        }

        result
    }

    pub fn register_encryption_key(
        env: Env,
        user: Address,
        key: Bytes,
    ) -> Result<(), MessagingError> {
        user.require_auth();
        require_initialized(&env)?;

        let mut keys = env
            .storage()
            .persistent()
            .get(&symbol_short!("enc_keys"))
            .unwrap_or_else(|| Map::<Address, Bytes>::new(&env));
        keys.set(user.clone(), key.clone());
        env.storage()
            .persistent()
            .set(&symbol_short!("enc_keys"), &keys);

        env.events()
            .publish((symbol_short!("key_reg"),), (user, key));
        Ok(())
    }

    pub fn send_encrypted_message(
        env: Env,
        sender: Address,
        recipient: Address,
        payload: Bytes,
    ) -> Result<u64, MessagingError> {
        sender.require_auth();
        require_initialized(&env)?;
        check_and_consume_message_rate_limit(&env, &sender)?;

        CircuitBreaker::require_not_paused(&env, symbol_short!("send_em"));
        ReentrancyGuard::enter(&env);
        NonceManager::enforce_sequential_nonce(&env, 0, env.ledger().sequence() as u64);
        let _ = NonceManager::record_and_verify(&env, 0, env.ledger().sequence() as u64);

        CircuitBreaker::track_activity(&env, 1);

        if sender == recipient {
            ReentrancyGuard::exit(&env);
            return Err(MessagingError::InvalidRecipient);
        }

        let payload_len = payload.len();
        if payload_len == 0 || payload_len > MAX_MESSAGE_LENGTH {
            ReentrancyGuard::exit(&env);
            return Err(MessagingError::InvalidPayload);
        }

        let mut stats = get_stats_internal(&env);
        let message_id = stats.last_message_id + 1;

        let current_timestamp = env.ledger().timestamp();
        let nonce = env.ledger().sequence() as u64;

        let message = EncryptedMessage {
            id: message_id,
            sender: sender.clone(),
            recipient: recipient.clone(),
            payload,
            timestamp: current_timestamp,
            read: false,
            processed: true,
            nonce,
        };

        let mut messages = get_encrypted_messages_map(&env);
        messages.set(message_id, message);
        env.storage()
            .persistent()
            .set(&symbol_short!("enc_msgs"), &messages);

        let inbox_key = symbol_short!("einbox");
        let sent_key = symbol_short!("esent");

        let mut recipient_ids = get_user_message_ids(&env, &inbox_key, &recipient);
        recipient_ids.push_back(message_id);
        set_user_message_ids(&env, &inbox_key, &recipient, recipient_ids);

        let mut sender_ids = get_user_message_ids(&env, &sent_key, &sender);
        sender_ids.push_back(message_id);
        set_user_message_ids(&env, &sent_key, &sender, sender_ids);

        let mut unread_counts = get_unread_counts(&env);
        let unread_count = unread_counts.get(recipient.clone()).unwrap_or(0);
        unread_counts.set(recipient.clone(), unread_count + 1);
        env.storage()
            .persistent()
            .set(&symbol_short!("unread"), &unread_counts);

        stats.total_messages += 1;
        stats.unread_messages += 1;
        stats.last_message_id = message_id;
        env.storage()
            .persistent()
            .set(&symbol_short!("stats"), &stats);

        let message_sent_event = EncryptedMessageSent {
            message_id,
            sender: sender.clone(),
            recipient,
            timestamp: current_timestamp,
            payload_length: payload_len as u32,
        };

        env.events()
            .publish((symbol_short!("emsg_sent"),), message_sent_event);

        ReentrancyGuard::exit(&env);
        Ok(message_id)
    }

    pub fn get_encrypted_messages(
        env: Env,
        user: Address,
        include_sent: bool,
        include_received: bool,
        unread_only: bool,
    ) -> Result<Vec<EncryptedMessage>, MessagingError> {
        user.require_auth();
        require_initialized(&env)?;

        let messages = get_encrypted_messages_map(&env);
        let mut result = Vec::new(&env);

        if include_received {
            let inbox_key = symbol_short!("einbox");
            let inbox_ids = get_user_message_ids(&env, &inbox_key, &user);
            for message_id in inbox_ids.iter() {
                if let Some(message) = messages.get(message_id) {
                    if !unread_only || !message.read {
                        result.push_back(message);
                    }
                }
            }
        }

        if include_sent {
            let sent_key = symbol_short!("esent");
            let sent_ids = get_user_message_ids(&env, &sent_key, &user);
            for message_id in sent_ids.iter() {
                if let Some(message) = messages.get(message_id) {
                    if !unread_only || !message.read {
                        result.push_back(message);
                    }
                }
            }
        }

        Ok(result)
    }

    pub fn mark_encrypted_as_read(
        env: Env,
        recipient: Address,
        message_id: u64,
    ) -> Result<(), MessagingError> {
        recipient.require_auth();
        require_initialized(&env)?;

        let mut messages = get_encrypted_messages_map(&env);
        let mut message = messages
            .get(message_id)
            .ok_or(MessagingError::MessageNotFound)?;

        if message.recipient != recipient {
            return Err(MessagingError::Unauthorized);
        }

        if message.read {
            return Err(MessagingError::AlreadyRead);
        }

        ReentrancyGuard::enter(&env);

        let current_timestamp = env.ledger().timestamp();

        message.read = true;
        messages.set(message_id, message.clone());
        env.storage()
            .persistent()
            .set(&symbol_short!("enc_msgs"), &messages);

        let mut unread_counts = get_unread_counts(&env);
        let unread_count = unread_counts.get(recipient.clone()).unwrap_or(0);
        unread_counts.set(recipient.clone(), unread_count.saturating_sub(1));
        env.storage()
            .persistent()
            .set(&symbol_short!("unread"), &unread_counts);

        let mut stats = get_stats_internal(&env);
        stats.unread_messages = stats.unread_messages.saturating_sub(1);
        env.storage()
            .persistent()
            .set(&symbol_short!("stats"), &stats);

        let message_read_event = MessageRead {
            message_id,
            recipient,
            sender: message.sender,
            timestamp: current_timestamp,
        };

        env.events()
            .publish((symbol_short!("emsg_read"),), message_read_event);

        ReentrancyGuard::exit(&env);
        Ok(())
    }
}

#[cfg(test)]
mod test;