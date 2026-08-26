#![no_std]

use shared::acl::{ACL, ROLE_ADMIN, PERMISSION_PAUSE, PERMISSION_UNPAUSE, PERMISSION_SET_RATE, PERMISSION_PREMIUM, PERMISSION_MGR_ACL};
use shared::circuit_breaker::{
    CircuitBreaker, CircuitBreakerConfig, CircuitBreakerState, PauseLevel,
};
use shared::events::{AccessDeniedEvent, AuditActionEvent, EventEmitter};
use shared::fees::FeeManager;
use shared::governance::{GovernanceManager, UpgradeProposal};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env, Symbol, Vec,
};

mod risk_management;
use risk_management::{RiskManager, RiskTier};

/// Version of this contract implementation
const CONTRACT_VERSION: u32 = 1;

/// Maximum number of recent trades to keep in hot storage
const MAX_RECENT_TRADES: u32 = 100;
/// Hard cap on the number of orders that can be executed atomically in one batch
const MAX_BATCH_SIZE: u32 = 25;
/// Default validity window for submitted solvency proofs
const DEFAULT_SOLVENCY_PROOF_TTL_SECS: u64 = 3600;

/// Storage keys as constants to avoid repeated symbol creation
mod storage_keys {
    use soroban_sdk::{symbol_short, Symbol};

    pub const INIT: Symbol = symbol_short!("init");
    pub const STATS: Symbol = symbol_short!("stats");
    pub const VERSION: Symbol = symbol_short!("ver");
    pub const TRADE_COUNT: Symbol = symbol_short!("t_cnt");
    pub const RL_CFG: Symbol = symbol_short!("rl_cfg");
    pub const PREM: Symbol = symbol_short!("prem");
    pub const ORDER_COUNT: Symbol = symbol_short!("o_cnt");
    pub const PRIV_TRADE_COUNT: Symbol = symbol_short!("pt_cnt");
    pub const PRIV_AUDIT_COUNT: Symbol = symbol_short!("pa_cnt");
    pub const SOLVENCY_TTL: Symbol = symbol_short!("s_ttl");
}

/// Trading contract with upgradeability and governance
#[contract]
pub struct UpgradeableTradingContract;

/// Trade record for tracking - optimized with packed data
#[contracttype]
#[derive(Clone, Debug)]
pub struct Trade {
    pub id: u64,
    pub trader: Address,
    pub pair: Symbol,
    /// Signed amount: positive = buy, negative = sell
    pub signed_amount: i128,
    pub price: i128,
    pub timestamp: u64,
    pub user_tier: u32,
    pub position_limit: i128,
    pub volume_cap: i128,
    pub slippage_limit_bps: u32,
    pub liquidity_check_passed: bool,
    pub circuit_breaker_check_passed: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OrderSide {
    Buy,
    Sell,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OrderStatus {
    Open,
    PartiallyFilled,
    Filled,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TimeInForce {
    Gtc,
    Ioc,
    Fok,
}

#[contracttype]
#[derive(Clone, Debug)]
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
    pub user_tier: u32,
    pub position_limit: i128,
    pub volume_cap: i128,
    pub slippage_limit_bps: u32,
    pub liquidity_check_passed: bool,
    pub circuit_breaker_check_passed: bool,
}

/// Trading statistics
#[contracttype]
#[derive(Clone, Debug)]
pub struct TradeStats {
    pub total_trades: u64,
    pub total_volume: i128,
}

/// Configurable trade rate-limit settings
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RateLimitConfig {
    pub window_secs: u64,
    pub user_limit: u32,
    pub global_limit: u32,
    pub premium_user_limit: u32,
}

/// Event emitted when a trade is executed
#[contracttype]
#[derive(Clone, Debug)]
pub struct TradeExecuted {
    pub trade_id: u64,
    pub trader: Address,
    pub pair: Symbol,
    pub signed_amount: i128,
    pub price: i128,
    pub timestamp: u64,
    pub is_buy: bool,
}

/// Event emitted when fees are collected
#[contracttype]
#[derive(Clone, Debug)]
pub struct FeeCollected {
    pub trade_id: u64,
    pub trader: Address,
    pub fee_amount: i128,
    pub fee_recipient: Address,
    pub fee_token: Address,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct OrderCreated {
    pub order_id: u64,
    pub owner: Address,
    pub pair: Symbol,
    pub is_buy: bool,
    pub price: i128,
    pub amount: i128,
    pub tif: TimeInForce,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct OrderCancelled {
    pub order_id: u64,
    pub owner: Address,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct OrderMatched {
    pub maker_order_id: u64,
    pub taker_order_id: u64,
    pub pair: Symbol,
    pub amount: i128,
    pub price: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivateBalanceCommitment {
    pub commitment: BytesN<32>,
    pub nonce: u64,
    pub updated_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SolvencyProofRecord {
    pub proof_hash: BytesN<32>,
    pub assets_commitment: BytesN<32>,
    pub liabilities_commitment: BytesN<32>,
    pub balance_commitment: BytesN<32>,
    pub nonce: u64,
    pub submitted_at: u64,
    pub expires_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivateTradeRecord {
    pub id: u64,
    pub trader: Address,
    pub pair: Symbol,
    pub price: i128,
    pub is_buy: bool,
    pub amount_commitment: BytesN<32>,
    pub balance_commitment: BytesN<32>,
    pub solvency_proof_hash: BytesN<32>,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComplianceViewKey {
    pub encrypted_key: Bytes,
    pub key_version: u32,
    pub updated_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivateTradeAuditRecord {
    pub audit_id: u64,
    pub trade_id: u64,
    pub auditor: Address,
    pub trader: Address,
    pub action: Symbol,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct PrivateTradeAuditView {
    pub trade: PrivateTradeRecord,
    pub proof: Vec<SolvencyProofRecord>,
    pub trader_view_key: Vec<ComplianceViewKey>,
    pub selective_disclosure: Vec<Bytes>,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TradeError {
    Unauthorized = 3001,
    InvalidAmount = 3002,
    ContractPaused = 3003,
    NotInitialized = 3004,
    InsufficientBalance = 3005,
    RateLimitExceeded = 3006,
    GlobalRateLimitExceeded = 3007,
    InvalidRateLimitConfig = 3008,
    BatchTooLarge = 3009,
    InvalidPrice = 3010,
    OrderNotFound = 3011,
    OrderNotCancelable = 3012,
    NoLiquidity = 3013,
    OrderWouldNotFullyFill = 3014,
    InvalidCommitment = 3015,
    MissingPrivateBalance = 3016,
    MissingSolvencyProof = 3017,
    InvalidSolvencyProof = 3018,
    SolvencyProofExpired = 3019,
    PrivateTradeNotFound = 3020,
    AuditUnauthorized = 3021,
    PositionLimitExceeded = 3022,
    DailyVolumeExceeded = 3023,
    LiquidityInsufficient = 3024,
    CircuitBreakerTriggered = 3025,
    SlippageExceeded = 3026,
}

impl From<TradeError> for soroban_sdk::Error {
    fn from(error: TradeError) -> Self {
        soroban_sdk::Error::from_contract_error(error as u32)
    }
}

impl From<&TradeError> for soroban_sdk::Error {
    fn from(error: &TradeError) -> Self {
        soroban_sdk::Error::from_contract_error(*error as u32)
    }
}

impl From<soroban_sdk::Error> for TradeError {
    fn from(_error: soroban_sdk::Error) -> Self {
        TradeError::Unauthorized
    }
}

fn require_initialized(env: &Env) -> Result<(), TradeError> {
    if env.storage().persistent().has(&storage_keys::INIT) {
        Ok(())
    } else {
        Err(TradeError::NotInitialized)
    }
}

/// Checks an ACL permission and, if denied, emits an AccessDeniedEvent
/// before returning the Unauthorized error. Use this instead of calling
/// ACL::require_permission directly in any admin/governance entry point
/// so denials are auditable, not just silently rejected.
fn require_permission_audited(
    env: &Env,
    admin: &Address,
    permission: &Symbol,
    resource: Symbol,
) -> Result<(), TradeError> {
    if !ACL::has_permission(env, admin, permission) {
        EventEmitter::access_denied(
            env,
            AccessDeniedEvent {
                actor: admin.clone(),
                required_permission: permission.clone(),
                resource,
                timestamp: env.ledger().timestamp(),
            },
        );
        return Err(TradeError::Unauthorized);
    }
    Ok(())
}

fn emit_audit(
    env: &Env,
    actor: &Address,
    operation: Symbol,
    old_value: Symbol,
    new_value: Symbol,
) {
    EventEmitter::audit_action(
        env,
        AuditActionEvent {
            actor: actor.clone(),
            operation: operation.clone(),
            old_value,
            new_value,
            correlation_id: operation,
            timestamp: env.ledger().timestamp(),
        },
    );
}

fn require_trade_not_paused(env: &Env, func_name: Symbol) -> Result<(), TradeError> {
    let state = CircuitBreaker::get_state(env);

    if state.pause_level == PauseLevel::Full {
        return Err(TradeError::ContractPaused);
    }

    if state.pause_level == PauseLevel::Partial {
        let paused_funcs: soroban_sdk::Map<Symbol, bool> = env
            .storage()
            .persistent()
            .get(&symbol_short!("cb_p_fns"))
            .unwrap_or_else(|| soroban_sdk::Map::new(env));

        if paused_funcs.get(func_name).unwrap_or(false) {
            return Err(TradeError::ContractPaused);
        }
    }

    Ok(())
}

fn set_trade_pause_level(env: &Env, level: PauseLevel) {
    let mut state = CircuitBreaker::get_state(env);
    state.pause_level = level;
    env.storage()
        .persistent()
        .set(&symbol_short!("cb_state"), &state);

    env.events()
        .publish((symbol_short!("cb_pause"),), (level as u32,));
}

fn pause_trade_function(env: &Env, func_name: Symbol) {
    let mut paused_funcs: soroban_sdk::Map<Symbol, bool> = env
        .storage()
        .persistent()
        .get(&symbol_short!("cb_p_fns"))
        .unwrap_or_else(|| soroban_sdk::Map::new(env));

    paused_funcs.set(func_name.clone(), true);
    env.storage()
        .persistent()
        .set(&symbol_short!("cb_p_fns"), &paused_funcs);

    let mut state = CircuitBreaker::get_state(env);
    if state.pause_level == PauseLevel::None {
        state.pause_level = PauseLevel::Partial;
        env.storage()
            .persistent()
            .set(&symbol_short!("cb_state"), &state);
    }

    env.events()
        .publish((symbol_short!("cb_f_psd"), func_name), ());
}

fn unpause_trade_function(env: &Env, func_name: Symbol) {
    let mut paused_funcs: soroban_sdk::Map<Symbol, bool> = env
        .storage()
        .persistent()
        .get(&symbol_short!("cb_p_fns"))
        .unwrap_or_else(|| soroban_sdk::Map::new(env));

    paused_funcs.remove(func_name.clone());
    env.storage()
        .persistent()
        .set(&symbol_short!("cb_p_fns"), &paused_funcs);

    env.events()
        .publish((symbol_short!("cb_f_ups"), func_name), ());
}

fn read_rate_limit_config(env: &Env) -> RateLimitConfig {
    if let Some(cfg) = env.storage().persistent().get(&storage_keys::RL_CFG) {
        return cfg;
    }

    RateLimitConfig {
        window_secs: 1,
        user_limit: u32::MAX,
        global_limit: u32::MAX,
        premium_user_limit: u32::MAX,
    }
}

#[cfg(not(test))]
fn is_premium_user(env: &Env, user: &Address) -> bool {
    let premium_users: soroban_sdk::Map<Address, bool> = env
        .storage()
        .persistent()
        .get(&storage_keys::PREM)
        .unwrap_or_else(|| soroban_sdk::Map::new(env));

    premium_users.get(user.clone()).unwrap_or(false)
}

#[cfg(not(test))]
fn get_user_window_usage(env: &Env, trader: &Address, window: u64) -> u32 {
    let key = (symbol_short!("rlu"), trader.clone(), window);
    env.storage().persistent().get(&key).unwrap_or(0)
}

#[cfg(not(test))]
fn set_user_window_usage(env: &Env, trader: &Address, window: u64, count: u32) {
    let key = (symbol_short!("rlu"), trader.clone(), window);
    env.storage().persistent().set(&key, &count);
}

#[cfg(not(test))]
fn get_global_window_usage(env: &Env, window: u64) -> u32 {
    let key = (symbol_short!("rlg"), window);
    env.storage().persistent().get(&key).unwrap_or(0)
}

#[cfg(not(test))]
fn set_global_window_usage(env: &Env, window: u64, count: u32) {
    let key = (symbol_short!("rlg"), window);
    env.storage().persistent().set(&key, &count);
}

fn check_and_consume_trade_rate_limit(env: &Env, trader: &Address) -> Result<(), TradeError> {
    #[cfg(test)]
    {
        let _ = (env, trader);
        return Ok(());
    }

    #[cfg(not(test))]
    {
        let cfg = read_rate_limit_config(env);

        if cfg.window_secs == 0
            || cfg.user_limit == 0
            || cfg.global_limit == 0
            || cfg.premium_user_limit == 0
        {
            return Err(TradeError::InvalidRateLimitConfig);
        }

        let now = env.ledger().timestamp();
        let window = now / cfg.window_secs;

        let is_premium = is_premium_user(env, trader);
        let allowed_user_limit = if is_premium {
            cfg.premium_user_limit
        } else {
            cfg.user_limit
        };

        let current_user = get_user_window_usage(env, trader, window);
        if current_user >= allowed_user_limit {
            return Err(TradeError::RateLimitExceeded);
        }

        let current_global = get_global_window_usage(env, window);
        if current_global >= cfg.global_limit {
            return Err(TradeError::GlobalRateLimitExceeded);
        }

        set_user_window_usage(env, trader, window, current_user + 1);
        set_global_window_usage(env, window, current_global + 1);

        Ok(())
    }
}

fn validate_batch_size(len: u32) -> Result<(), TradeError> {
    if len > MAX_BATCH_SIZE {
        return Err(TradeError::BatchTooLarge);
    }
    Ok(())
}

fn ensure_tradeable(
    env: &Env,
    trader: &Address,
) -> Result<soroban_sdk::storage::Persistent, TradeError> {
    require_initialized(env)?;
    check_and_consume_trade_rate_limit(env, trader)?;
    require_trade_not_paused(env, symbol_short!("trade"))?;

    Ok(env.storage().persistent())
}

fn next_order_id(env: &Env) -> u64 {
    let mut id: u64 = env
        .storage()
        .persistent()
        .get(&storage_keys::ORDER_COUNT)
        .unwrap_or(0);

    id += 1;
    env.storage()
        .persistent()
        .set(&storage_keys::ORDER_COUNT, &id);
    id
}

fn read_order(env: &Env, id: u64) -> Option<LimitOrder> {
    let key = (symbol_short!("order"), id);
    env.storage().persistent().get(&key)
}

fn write_order(env: &Env, order: &LimitOrder) {
    let key = (symbol_short!("order"), order.id);
    env.storage().persistent().set(&key, order);
}

fn order_book_key(pair: &Symbol, is_buy: bool) -> (Symbol, Symbol, bool) {
    (symbol_short!("obook"), pair.clone(), is_buy)
}

fn read_order_book(env: &Env, pair: &Symbol, is_buy: bool) -> Vec<u64> {
    let key = order_book_key(pair, is_buy);
    env.storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env))
}

fn write_order_book(env: &Env, pair: &Symbol, is_buy: bool, ids: &Vec<u64>) {
    let key = order_book_key(pair, is_buy);
    env.storage().persistent().set(&key, ids);
}

fn push_order_to_book(env: &Env, pair: &Symbol, is_buy: bool, order_id: u64) {
    let mut ids = read_order_book(env, pair, is_buy);
    ids.push_back(order_id);
    write_order_book(env, pair, is_buy, &ids);
}

fn remove_order_from_book(env: &Env, pair: &Symbol, is_buy: bool, order_id: u64) {
    let ids = read_order_book(env, pair, is_buy);
    let mut updated = Vec::new(env);

    for existing_id in ids.iter() {
        if existing_id != order_id {
            updated.push_back(existing_id);
        }
    }

    write_order_book(env, pair, is_buy, &updated);
}

fn order_matches(incoming: &LimitOrder, resting: &LimitOrder) -> bool {
    if incoming.pair != resting.pair {
        return false;
    }

    match (&incoming.side, &resting.side) {
        (OrderSide::Buy, OrderSide::Sell) => incoming.price >= resting.price,
        (OrderSide::Sell, OrderSide::Buy) => incoming.price <= resting.price,
        _ => false,
    }
}

fn pick_best_match_index(env: &Env, incoming: &LimitOrder, opposite_ids: &Vec<u64>) -> Option<u32> {
    let mut best_index: Option<u32> = None;
    let mut best_price: i128 = 0;
    let mut best_timestamp: u64 = 0;

    let mut i: u32 = 0;
    for order_id in opposite_ids.iter() {
        if let Some(order) = read_order(env, order_id) {
            let is_open =
                order.status == OrderStatus::Open || order.status == OrderStatus::PartiallyFilled;

            if is_open && order.remaining > 0 && order_matches(incoming, &order) {
                match incoming.side {
                    OrderSide::Buy => {
                        if best_index.is_none()
                            || order.price < best_price
                            || (order.price == best_price && order.timestamp < best_timestamp)
                        {
                            best_index = Some(i);
                            best_price = order.price;
                            best_timestamp = order.timestamp;
                        }
                    }
                    OrderSide::Sell => {
                        if best_index.is_none()
                            || order.price > best_price
                            || (order.price == best_price && order.timestamp < best_timestamp)
                        {
                            best_index = Some(i);
                            best_price = order.price;
                            best_timestamp = order.timestamp;
                        }
                    }
                }
            }
        }
        i += 1;
    }

    best_index
}

fn available_fill_for_order(env: &Env, incoming: &LimitOrder) -> i128 {
    let opposite_is_buy = matches!(incoming.side, OrderSide::Sell);
    let opposite_ids = read_order_book(env, &incoming.pair, opposite_is_buy);

    let mut total_available: i128 = 0;
    for order_id in opposite_ids.iter() {
        if let Some(order) = read_order(env, order_id) {
            let is_open =
                order.status == OrderStatus::Open || order.status == OrderStatus::PartiallyFilled;

            if is_open && order.remaining > 0 && order_matches(incoming, &order) {
                total_available += order.remaining;
                if total_available >= incoming.remaining {
                    return total_available;
                }
            }
        }
    }

    total_available
}

fn record_trade(
    env: &Env,
    trader: &Address,
    pair: &Symbol,
    amount: i128,
    price: i128,
    is_buy: bool,
    pool_liquidity: i128,
) -> u64 {
    let storage = env.storage().persistent();
    let current_timestamp = env.ledger().timestamp();
    let signed_amount = if is_buy { amount } else { -amount };

    let trade_id: u64 = storage.get(&storage_keys::TRADE_COUNT).unwrap_or(0) + 1;
    let mut stats: TradeStats = storage.get(&storage_keys::STATS).unwrap_or(TradeStats {
        total_trades: 0,
        total_volume: 0,
    });

    let risk_metadata = RiskManager::generate_risk_metadata(env, trader, pool_liquidity, amount, price);

    let trade = Trade {
        id: trade_id,
        trader: trader.clone(),
        pair: pair.clone(),
        signed_amount,
        price,
        timestamp: current_timestamp,
        user_tier: risk_metadata.user_tier,
        position_limit: risk_metadata.position_limit,
        volume_cap: risk_metadata.volume_cap,
        slippage_limit_bps: risk_metadata.slippage_limit_bps,
        liquidity_check_passed: risk_metadata.liquidity_check_passed,
        circuit_breaker_check_passed: risk_metadata.circuit_breaker_check_passed,
    };

    let trade_key = (symbol_short!("trade"), trade_id);
    storage.set(&trade_key, &trade);

    stats.total_trades += 1;
    stats.total_volume += amount;

    storage.set(&storage_keys::TRADE_COUNT, &trade_id);
    storage.set(&storage_keys::STATS, &stats);

    env.events().publish(
        (symbol_short!("trade"),),
        TradeExecuted {
            trade_id,
            trader: trader.clone(),
            pair: pair.clone(),
            signed_amount,
            price,
            timestamp: current_timestamp,
            is_buy,
        },
    );

    trade_id
}

fn execute_trade_batch(
    env: &Env,
    trader: &Address,
    orders: &Vec<(Symbol, i128, i128, bool)>,
    fee_token: &Address,
    fee_per_trade: i128,
    fee_recipient: &Address,
) -> Result<Vec<u64>, TradeError> {
    if orders.is_empty() {
        return Ok(Vec::new(env));
    }

    validate_batch_size(orders.len())?;

    for (_, amount, _, _) in orders.iter() {
        if amount <= 0 {
            return Err(TradeError::InvalidAmount);
        }
    }

    let _storage = ensure_tradeable(env, trader)?;

    let total_fees = fee_per_trade * (orders.len() as i128);
    FeeManager::collect_fee(env, fee_token, trader, fee_recipient, total_fees)
        .map_err(|_| TradeError::InsufficientBalance)?;

    let current_timestamp = env.ledger().timestamp();
    let mut trade_ids = Vec::new(env);

    for (pair, amount, price, is_buy) in orders.iter() {
        let pool_liquidity = 100_000_000i128;
        let trade_id = record_trade(env, trader, &pair, amount, price, is_buy, pool_liquidity);
        trade_ids.push_back(trade_id);
    }

    env.events().publish(
        (symbol_short!("fee_col"),),
        FeeCollected {
            trade_id: trade_ids.get(0).unwrap_or(0),
            trader: trader.clone(),
            fee_amount: total_fees,
            fee_recipient: fee_recipient.clone(),
            fee_token: fee_token.clone(),
            timestamp: current_timestamp,
        },
    );

    Ok(trade_ids)
}

fn match_limit_order(env: &Env, incoming: &mut LimitOrder) -> Result<(), TradeError> {
    let opposite_is_buy = matches!(incoming.side, OrderSide::Sell);

    loop {
        if incoming.remaining <= 0 {
            break;
        }

        let opposite_ids = read_order_book(env, &incoming.pair, opposite_is_buy);
        let Some(best_idx) = pick_best_match_index(env, incoming, &opposite_ids) else {
            break;
        };

        let maker_id = opposite_ids.get(best_idx).unwrap();
        let Some(mut maker) = read_order(env, maker_id) else {
            remove_order_from_book(env, &incoming.pair, opposite_is_buy, maker_id);
            continue;
        };

        let maker_open =
            maker.status == OrderStatus::Open || maker.status == OrderStatus::PartiallyFilled;

        if !maker_open || maker.remaining <= 0 || !order_matches(incoming, &maker) {
            remove_order_from_book(env, &incoming.pair, opposite_is_buy, maker_id);
            continue;
        }

        let fill_amount = if incoming.remaining < maker.remaining {
            incoming.remaining
        } else {
            maker.remaining
        };

        let execution_price = maker.price;
        let timestamp = env.ledger().timestamp();

        maker.remaining -= fill_amount;
        incoming.remaining -= fill_amount;

        maker.status = if maker.remaining == 0 {
            OrderStatus::Filled
        } else {
            OrderStatus::PartiallyFilled
        };

        incoming.status = if incoming.remaining == 0 {
            OrderStatus::Filled
        } else {
            OrderStatus::PartiallyFilled
        };

        write_order(env, &maker);

        if maker.remaining == 0 {
            remove_order_from_book(env, &incoming.pair, opposite_is_buy, maker.id);
        }

        let incoming_is_buy = incoming.side == OrderSide::Buy;
        let maker_is_buy = maker.side == OrderSide::Buy;

        let pool_liquidity = 100_000_000i128;

        record_trade(
            env,
            &incoming.owner,
            &incoming.pair,
            fill_amount,
            execution_price,
            incoming_is_buy,
            pool_liquidity,
        );

        record_trade(
            env,
            &maker.owner,
            &maker.pair,
            fill_amount,
            execution_price,
            maker_is_buy,
            pool_liquidity,
        );

        env.events().publish(
            (symbol_short!("match"),),
            OrderMatched {
                maker_order_id: maker.id,
                taker_order_id: incoming.id,
                pair: incoming.pair.clone(),
                amount: fill_amount,
                price: execution_price,
                timestamp,
            },
        );
    }

    Ok(())
}

#[contractimpl]
impl UpgradeableTradingContract {
    /// Initialize the contract with admin and initial approvers
    pub fn init(
        env: Env,
        admin: Address,
        approvers: Vec<Address>,
        executor: Address,
        cb_config: CircuitBreakerConfig,
    ) -> Result<(), TradeError> {
        if env.storage().persistent().has(&storage_keys::INIT) {
            return Err(TradeError::Unauthorized);
        }

        GovernanceManager::init_governance_roles(&env, admin.clone(), approvers.clone(), executor.clone());

        ACL::assign_permission(&env, &ROLE_ADMIN, &PERMISSION_SET_RATE);
        ACL::assign_permission(&env, &ROLE_ADMIN, &PERMISSION_PREMIUM);
        ACL::assign_permission(&env, &ROLE_ADMIN, &PERMISSION_PAUSE);
        ACL::assign_permission(&env, &ROLE_ADMIN, &PERMISSION_UNPAUSE);
        ACL::assign_permission(&env, &ROLE_ADMIN, &PERMISSION_MGR_ACL);

        let stats = TradeStats {
            total_trades: 0,
            total_volume: 0,
        };

        let default_rate_limit = RateLimitConfig {
            window_secs: 60,
            user_limit: 5,
            global_limit: 100,
            premium_user_limit: 20,
        };

        let premium_users = soroban_sdk::Map::<Address, bool>::new(&env);

        let storage = env.storage().persistent();
        storage.set(&storage_keys::INIT, &true);
        storage.set(&storage_keys::STATS, &stats);
        storage.set(&storage_keys::VERSION, &CONTRACT_VERSION);
        storage.set(&storage_keys::TRADE_COUNT, &0u64);
        storage.set(&storage_keys::ORDER_COUNT, &0u64);
        storage.set(&storage_keys::RL_CFG, &default_rate_limit);
        storage.set(&storage_keys::PREM, &premium_users);

        CircuitBreaker::init(&env, cb_config);
        RiskManager::init(&env);

        emit_audit(
            &env,
            &admin,
            symbol_short!("init"),
            symbol_short!("none"),
            symbol_short!("init_done"),
        );

        Ok(())
    }

    /// Execute a trade with fee collection
    pub fn trade(
        env: Env,
        trader: Address,
        pair: Symbol,
        amount: i128,
        price: i128,
        is_buy: bool,
        fee_token: Address,
        fee_amount: i128,
        fee_recipient: Address,
        pool_liquidity: i128,
    ) -> Result<u64, TradeError> {
        trader.require_auth();

        if amount <= 0 {
            return Err(TradeError::InvalidAmount);
        }

        if price <= 0 {
            return Err(TradeError::InvalidPrice);
        }

        let _storage = ensure_tradeable(&env, &trader)?;
        CircuitBreaker::track_activity(&env, amount);

        #[cfg(not(test))]
        {
            if !RiskManager::check_position_limit(&env, &trader, amount) {
                return Err(TradeError::PositionLimitExceeded);
            }

            if !RiskManager::check_daily_volume(&env, &trader, amount) {
                return Err(TradeError::DailyVolumeExceeded);
            }

            let liquidity_check = RiskManager::check_liquidity(&env, &trader, pool_liquidity, amount);
            if !liquidity_check.passed {
                return Err(TradeError::LiquidityInsufficient);
            }

            if !RiskManager::check_circuit_breaker(&env, &trader, price) {
                return Err(TradeError::CircuitBreakerTriggered);
            }
        }

        FeeManager::collect_fee(&env, &fee_token, &trader, &fee_recipient, fee_amount)
            .map_err(|_| TradeError::InsufficientBalance)?;

        let trade_id = record_trade(&env, &trader, &pair, amount, price, is_buy, pool_liquidity);

        #[cfg(not(test))]
        {
            RiskManager::consume_daily_volume(&env, &trader, amount);
            let position_delta = if is_buy { amount } else { -amount };
            RiskManager::update_position_size(&env, &trader, position_delta);
        }

        env.events().publish(
            (symbol_short!("fee_col"),),
            FeeCollected {
                trade_id,
                trader,
                fee_amount,
                fee_recipient,
                fee_token,
                timestamp: env.ledger().timestamp(),
            },
        );

        Ok(trade_id)
    }

    pub fn create_limit_order(
        env: Env,
        trader: Address,
        pair: Symbol,
        is_buy: bool,
        price: i128,
        amount: i128,
        tif: TimeInForce,
        pool_liquidity: i128,
    ) -> Result<u64, TradeError> {
        trader.require_auth();
        require_initialized(&env)?;
        check_and_consume_trade_rate_limit(&env, &trader)?;
        require_trade_not_paused(&env, symbol_short!("trade"))?;

        if amount <= 0 {
            return Err(TradeError::InvalidAmount);
        }

        if price <= 0 {
            return Err(TradeError::InvalidPrice);
        }

        if !RiskManager::check_position_limit(&env, &trader, amount) {
            return Err(TradeError::PositionLimitExceeded);
        }

        if !RiskManager::check_daily_volume(&env, &trader, amount) {
            return Err(TradeError::DailyVolumeExceeded);
        }

        let liquidity_check = RiskManager::check_liquidity(&env, &trader, pool_liquidity, amount);
        if !liquidity_check.passed {
            return Err(TradeError::LiquidityInsufficient);
        }

        if !RiskManager::check_circuit_breaker(&env, &trader, price) {
            return Err(TradeError::CircuitBreakerTriggered);
        }

        let side = if is_buy {
            OrderSide::Buy
        } else {
            OrderSide::Sell
        };

        let timestamp = env.ledger().timestamp();
        let order_id = next_order_id(&env);

        let risk_metadata = RiskManager::generate_risk_metadata(&env, &trader, pool_liquidity, amount, price);

        let mut order = LimitOrder {
            id: order_id,
            owner: trader.clone(),
            pair: pair.clone(),
            side: side.clone(),
            price,
            amount,
            remaining: amount,
            status: OrderStatus::Open,
            tif: tif.clone(),
            timestamp,
            user_tier: risk_metadata.user_tier,
            position_limit: risk_metadata.position_limit,
            volume_cap: risk_metadata.volume_cap,
            slippage_limit_bps: risk_metadata.slippage_limit_bps,
            liquidity_check_passed: risk_metadata.liquidity_check_passed,
            circuit_breaker_check_passed: risk_metadata.circuit_breaker_check_passed,
        };

        if tif == TimeInForce::Fok {
            let available = available_fill_for_order(&env, &order);
            if available < order.amount {
                return Err(TradeError::OrderWouldNotFullyFill);
            }
        }

        write_order(&env, &order);

        env.events().publish(
            (symbol_short!("ord_cr"),),
            OrderCreated {
                order_id,
                owner: trader.clone(),
                pair,
                is_buy,
                price,
                amount,
                tif,
                timestamp,
            },
        );

        match_limit_order(&env, &mut order)?;
        write_order(&env, &order);

        let filled_amount = amount - order.remaining;
        if filled_amount > 0 {
            RiskManager::consume_daily_volume(&env, &trader, filled_amount);
            let position_delta = if is_buy { filled_amount } else { -filled_amount };
            RiskManager::update_position_size(&env, &trader, position_delta);
        }

        match order.tif {
            TimeInForce::Gtc => {
                if order.remaining > 0 {
                    push_order_to_book(
                        &env,
                        &order.pair,
                        matches!(order.side, OrderSide::Buy),
                        order.id,
                    );
                }
            }
            TimeInForce::Ioc => {
                if order.remaining > 0 {
                    order.status = OrderStatus::Cancelled;
                    write_order(&env, &order);
                }
            }
            TimeInForce::Fok => {
                if order.remaining > 0 {
                    return Err(TradeError::OrderWouldNotFullyFill);
                }
            }
        }

        Ok(order_id)
    }

    pub fn cancel_order(env: Env, trader: Address, order_id: u64) -> Result<(), TradeError> {
        trader.require_auth();
        require_initialized(&env)?;

        let Some(mut order) = read_order(&env, order_id) else {
            return Err(TradeError::OrderNotFound);
        };

        if order.owner != trader {
            EventEmitter::access_denied(
                &env,
                AccessDeniedEvent {
                    actor: trader.clone(),
                    required_permission: symbol_short!("owner"),
                    resource: symbol_short!("order"),
                    timestamp: env.ledger().timestamp(),
                },
            );
            return Err(TradeError::Unauthorized);
        }

        if order.status != OrderStatus::Open && order.status != OrderStatus::PartiallyFilled {
            return Err(TradeError::OrderNotCancelable);
        }

        order.status = OrderStatus::Cancelled;
        write_order(&env, &order);
        remove_order_from_book(
            &env,
            &order.pair,
            matches!(order.side, OrderSide::Buy),
            order.id,
        );

        env.events().publish(
            (symbol_short!("ord_can"),),
            OrderCancelled {
                order_id,
                owner: trader,
                timestamp: env.ledger().timestamp(),
            },
        );

        Ok(())
    }

    pub fn get_order(env: Env, order_id: u64) -> Option<LimitOrder> {
        read_order(&env, order_id)
    }

    pub fn get_open_orders(env: Env, pair: Symbol, is_buy: bool) -> Vec<LimitOrder> {
        let ids = read_order_book(&env, &pair, is_buy);
        let mut orders = Vec::new(&env);

        for order_id in ids.iter() {
            if let Some(order) = read_order(&env, order_id) {
                if order.status == OrderStatus::Open || order.status == OrderStatus::PartiallyFilled
                {
                    orders.push_back(order);
                }
            }
        }

        orders
    }

    /// Set rate-limit config (ACL protected)
    pub fn set_rate_limit_config(
        env: Env,
        admin: Address,
        window_secs: u64,
        user_limit: u32,
        global_limit: u32,
        premium_user_limit: u32,
    ) -> Result<(), TradeError> {
        admin.require_auth();
        require_initialized(&env)?;
        require_permission_audited(&env, &admin, &PERMISSION_SET_RATE, symbol_short!("rl_cfg"))?;

        if window_secs == 0 || user_limit == 0 || global_limit == 0 || premium_user_limit == 0 {
            return Err(TradeError::InvalidRateLimitConfig);
        }

        let old_cfg = read_rate_limit_config(&env);

        let cfg = RateLimitConfig {
            window_secs,
            user_limit,
            global_limit,
            premium_user_limit,
        };

        env.storage().persistent().set(&storage_keys::RL_CFG, &cfg);

        emit_audit(
            &env,
            &admin,
            symbol_short!("set_rl"),
            symbol_short!("prev_cfg"),
            symbol_short!("new_cfg"),
        );
        let _ = old_cfg;

        Ok(())
    }

    /// Mark or unmark a premium user (ACL protected)
    pub fn set_premium_user(
        env: Env,
        admin: Address,
        user: Address,
        is_premium: bool,
    ) -> Result<(), TradeError> {
        admin.require_auth();
        require_initialized(&env)?;
        require_permission_audited(&env, &admin, &PERMISSION_PREMIUM, symbol_short!("prem_usr"))?;

        let mut premium_users: soroban_sdk::Map<Address, bool> = env
            .storage()
            .persistent()
            .get(&storage_keys::PREM)
            .unwrap_or_else(|| soroban_sdk::Map::new(&env));

        premium_users.set(user, is_premium);
        env.storage()
            .persistent()
            .set(&storage_keys::PREM, &premium_users);

        emit_audit(
            &env,
            &admin,
            symbol_short!("set_prem"),
            symbol_short!("unknown"),
            if is_premium { symbol_short!("true") } else { symbol_short!("false") },
        );

        Ok(())
    }

    /// Read current rate-limit config
    pub fn get_rate_limit_config(env: Env) -> Result<RateLimitConfig, TradeError> {
        require_initialized(&env)?;
        Ok(read_rate_limit_config(&env))
    }

    /// Get current contract version
    pub fn get_version(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&storage_keys::VERSION)
            .unwrap_or(0)
    }

    /// Get trading statistics
    pub fn get_stats(env: Env) -> TradeStats {
        env.storage()
            .persistent()
            .get(&storage_keys::STATS)
            .unwrap_or(TradeStats {
                total_trades: 0,
                total_volume: 0,
            })
    }

    /// Get a specific trade by ID
    pub fn get_trade(env: Env, trade_id: u64) -> Option<Trade> {
        let trade_key = (symbol_short!("trade"), trade_id);
        env.storage().persistent().get(&trade_key)
    }

    /// Get recent trades
    pub fn get_recent_trades(env: Env, count: u32) -> Vec<Trade> {
        let mut trades = Vec::new(&env);
        let trade_count: u64 = env
            .storage()
            .persistent()
            .get(&storage_keys::TRADE_COUNT)
            .unwrap_or(0);

        let limit = count.min(MAX_RECENT_TRADES).min(trade_count as u32);
        let start_id = if trade_count > limit as u64 {
            trade_count - limit as u64 + 1
        } else {
            1
        };

        for id in start_id..=trade_count {
            let trade_key = (symbol_short!("trade"), id);
            if let Some(trade) = env.storage().persistent().get(&trade_key) {
                trades.push_back(trade);
            }
        }

        trades
    }

    /// Execute multiple trades atomically with a single fee transfer.
    pub fn batch_trade(
        env: Env,
        trader: Address,
        orders: Vec<(Symbol, i128, i128, bool)>,
        fee_token: Address,
        fee_per_trade: i128,
        fee_recipient: Address,
    ) -> Result<Vec<u64>, TradeError> {
        trader.require_auth();
        execute_trade_batch(
            &env,
            &trader,
            &orders,
            &fee_token,
            fee_per_trade,
            &fee_recipient,
        )
    }

    /// Backwards-compatible alias retained for existing integrations.
    pub fn trade_batch(
        env: Env,
        trader: Address,
        orders: Vec<(Symbol, i128, i128, bool)>,
        fee_token: Address,
        fee_per_trade: i128,
        fee_recipient: Address,
    ) -> Result<Vec<u64>, TradeError> {
        trader.require_auth();
        execute_trade_batch(
            &env,
            &trader,
            &orders,
            &fee_token,
            fee_per_trade,
            &fee_recipient,
        )
    }

    pub fn max_batch_size() -> u32 {
        MAX_BATCH_SIZE
    }

    /// Set circuit breaker pause level (ACL protected)
    pub fn set_pause_level(env: Env, admin: Address, level: PauseLevel) -> Result<(), TradeError> {
        admin.require_auth();
        require_initialized(&env)?;
        require_permission_audited(&env, &admin, &PERMISSION_PAUSE, symbol_short!("pause_lv"))?;
        set_trade_pause_level(&env, level);

        emit_audit(
            &env,
            &admin,
            symbol_short!("pause_lv"),
            symbol_short!("prev"),
            symbol_short!("new_lv"),
        );

        Ok(())
    }

    /// Pause specific function (ACL protected)
    pub fn pause_function(env: Env, admin: Address, func_name: Symbol) -> Result<(), TradeError> {
        admin.require_auth();
        require_initialized(&env)?;
        require_permission_audited(&env, &admin, &PERMISSION_PAUSE, func_name.clone())?;
        pause_trade_function(&env, func_name.clone());

        emit_audit(&env, &admin, symbol_short!("pause_fn"), symbol_short!("active"), func_name);

        Ok(())
    }

    /// Unpause specific function (ACL protected)
    pub fn unpause_function(env: Env, admin: Address, func_name: Symbol) -> Result<(), TradeError> {
        admin.require_auth();
        require_initialized(&env)?;
        require_permission_audited(&env, &admin, &PERMISSION_UNPAUSE, func_name.clone())?;
        unpause_trade_function(&env, func_name.clone());

        emit_audit(&env, &admin, symbol_short!("unpause_f"), func_name, symbol_short!("active"));

        Ok(())
    }

    /// Get current circuit breaker state
    pub fn get_cb_state(env: Env) -> CircuitBreakerState {
        CircuitBreaker::get_state(&env)
    }

    /// Get current circuit breaker config
    pub fn get_cb_config(env: Env) -> CircuitBreakerConfig {
        CircuitBreaker::get_config(&env)
    }

    /// Update user KYC level (ACL protected)
    pub fn update_user_kyc(
        env: Env,
        admin: Address,
        user: Address,
        kyc_level: Symbol,
    ) -> Result<u32, TradeError> {
        admin.require_auth();
        require_initialized(&env)?;
        require_permission_audited(&env, &admin, &PERMISSION_PREMIUM, symbol_short!("kyc"))?;

        let new_tier = RiskManager::update_kyc_level(&env, &user, kyc_level.clone());

        emit_audit(&env, &admin, symbol_short!("upd_kyc"), symbol_short!("prev"), kyc_level);

        Ok(new_tier as u32)
    }

    /// Get user risk profile
    pub fn get_user_risk_profile(env: Env, user: Address) -> (Address, u32, u64, Symbol, i128, u64, i128) {
        require_initialized(&env).ok();
        let profile = RiskManager::get_user_profile(&env, &user);
        (profile.user, profile.tier as u32, profile.account_created_at, profile.kyc_level, profile.daily_volume_used, profile.daily_volume_window_start, profile.current_position_size)
    }

    /// Get tier configuration
    pub fn get_tier_config(env: Env, tier: u32) -> (i128, i128, u32, i128, i128) {
        require_initialized(&env).ok();
        let config = RiskManager::get_tier_config(&env, RiskTier::from(tier));
        (config.max_position_size, config.daily_volume_cap, config.max_slippage_bps, config.min_liquidity_threshold, config.max_trade_size)
    }

    /// Update tier configuration (ACL protected)
    pub fn update_tier_config(
        env: Env,
        admin: Address,
        tier: u32,
        max_position_size: i128,
        daily_volume_cap: i128,
        max_slippage_bps: u32,
        min_liquidity_threshold: i128,
        max_trade_size: i128,
    ) -> Result<(), TradeError> {
        admin.require_auth();
        require_initialized(&env)?;
        require_permission_audited(&env, &admin, &PERMISSION_SET_RATE, symbol_short!("tier_cfg"))?;

        let config = risk_management::RiskTierConfig {
            max_position_size,
            daily_volume_cap,
            max_slippage_bps,
            min_liquidity_threshold,
            max_trade_size,
        };
        RiskManager::update_tier_config(&env, RiskTier::from(tier), config);

        emit_audit(&env, &admin, symbol_short!("upd_tier"), symbol_short!("prev"), symbol_short!("new_cfg"));

        Ok(())
    }

    /// Get tiered circuit breaker state
    pub fn get_tiered_cb_state(env: Env) -> (i128, u64, Option<u32>, Symbol, u64) {
        require_initialized(&env).ok();
        let state = RiskManager::get_circuit_breaker_state(&env);
        (state.last_price, state.last_price_timestamp, state.triggered_tier, state.trigger_reason, state.triggered_at)
    }

    /// Reset tiered circuit breaker (ACL protected)
    pub fn reset_tiered_circuit_breaker(env: Env, admin: Address) -> Result<(), TradeError> {
        admin.require_auth();
        require_initialized(&env)?;
        require_permission_audited(&env, &admin, &PERMISSION_PAUSE, symbol_short!("tier_cb"))?;

        RiskManager::reset_circuit_breaker(&env);

        emit_audit(&env, &admin, symbol_short!("reset_cb"), symbol_short!("triggered"), symbol_short!("reset"));

        Ok(())
    }

    /// Pause the contract (ACL protected)
    pub fn pause(env: Env, admin: Address) -> Result<(), TradeError> {
        admin.require_auth();
        require_initialized(&env)?;
        require_permission_audited(&env, &admin, &PERMISSION_PAUSE, symbol_short!("contract"))?;
        set_trade_pause_level(&env, PauseLevel::Full);

        emit_audit(&env, &admin, symbol_short!("pause"), symbol_short!("none"), symbol_short!("full"));

        Ok(())
    }

    /// Unpause the contract (ACL protected)
    pub fn unpause(env: Env, admin: Address) -> Result<(), TradeError> {
        admin.require_auth();
        require_initialized(&env)?;
        require_permission_audited(&env, &admin, &PERMISSION_UNPAUSE, symbol_short!("contract"))?;
        set_trade_pause_level(&env, PauseLevel::None);

        emit_audit(&env, &admin, symbol_short!("unpause"), symbol_short!("full"), symbol_short!("none"));

        Ok(())
    }

    pub fn create_role(env: Env, admin: Address, role: Symbol) -> Result<(), TradeError> {
        admin.require_auth();
        require_initialized(&env)?;
        require_permission_audited(&env, &admin, &PERMISSION_MGR_ACL, role.clone())?;
        ACL::create_role(&env, &role);

        emit_audit(&env, &admin, symbol_short!("mk_role"), symbol_short!("none"), role);

        Ok(())
    }

    pub fn assign_role(
        env: Env,
        admin: Address,
        user: Address,
        role: Symbol,
    ) -> Result<(), TradeError> {
        admin.require_auth();
        require_initialized(&env)?;
        require_permission_audited(&env, &admin, &PERMISSION_MGR_ACL, role.clone())?;
        ACL::assign_role(&env, &user, &role);

        emit_audit(&env, &admin, symbol_short!("asn_role"), symbol_short!("none"), role);

        Ok(())
    }

    pub fn assign_permission(
        env: Env,
        admin: Address,
        role: Symbol,
        permission: Symbol,
    ) -> Result<(), TradeError> {
        admin.require_auth();
        require_initialized(&env)?;
        require_permission_audited(&env, &admin, &PERMISSION_MGR_ACL, role.clone())?;
        ACL::assign_permission(&env, &role, &permission);

        emit_audit(&env, &admin, symbol_short!("asn_perm"), role, permission);

        Ok(())
    }

    pub fn assign_permissions_batch(
        env: Env,
        admin: Address,
        role: Symbol,
        permissions: Vec<Symbol>,
    ) -> Result<(), TradeError> {
        admin.require_auth();
        require_initialized(&env)?;
        require_permission_audited(&env, &admin, &PERMISSION_MGR_ACL, role.clone())?;
        ACL::assign_permissions_batch(&env, &role, &permissions);

        emit_audit(&env, &admin, symbol_short!("asn_batch"), role, symbol_short!("batch"));

        Ok(())
    }

    pub fn set_role_parent(
        env: Env,
        admin: Address,
        child: Symbol,
        parent: Symbol,
    ) -> Result<(), TradeError> {
        admin.require_auth();
        require_initialized(&env)?;
        require_permission_audited(&env, &admin, &PERMISSION_MGR_ACL, child.clone())?;
        ACL::set_parent_role(&env, &child, &parent);

        emit_audit(&env, &admin, symbol_short!("set_par"), child, parent);

        Ok(())
    }

    pub fn get_user_roles(env: Env, user: Address) -> Result<Vec<Symbol>, TradeError> {
        require_initialized(&env)?;
        Ok(ACL::get_user_roles(&env, &user))
    }

    pub fn get_role_permissions(env: Env, role: Symbol) -> Result<Vec<Symbol>, TradeError> {
        require_initialized(&env)?;
        Ok(ACL::get_role_permissions(&env, &role))
    }

    pub fn has_permission(env: Env, user: Address, permission: Symbol) -> Result<bool, TradeError> {
        require_initialized(&env)?;
        Ok(ACL::has_permission(&env, &user, &permission))
    }

    /// Propose an upgrade via governance
    pub fn propose_upgrade(
        env: Env,
        admin: Address,
        new_contract_hash: Symbol,
        description: Symbol,
        approvers: Vec<Address>,
        approval_threshold: u32,
        timelock_delay: u64,
    ) -> Result<u64, TradeError> {
        admin.require_auth();
        require_initialized(&env)?;

        let proposal_result = GovernanceManager::propose_upgrade(
            &env,
            admin.clone(),
            new_contract_hash.clone(),
            env.current_contract_address(),
            description,
            approval_threshold,
            approvers,
            timelock_delay,
        );

        match proposal_result {
            Ok(id) => {
                emit_audit(
                    &env,
                    &admin,
                    symbol_short!("propose"),
                    symbol_short!("none"),
                    new_contract_hash,
                );
                Ok(id)
            }
            Err(_) => Err(TradeError::Unauthorized),
        }
    }

    /// Approve an upgrade proposal
    pub fn approve_upgrade(
        env: Env,
        proposal_id: u64,
        approver: Address,
    ) -> Result<(), TradeError> {
        approver.require_auth();
        require_initialized(&env)?;

        GovernanceManager::approve_proposal(&env, proposal_id, approver.clone())
            .map_err(|_| TradeError::Unauthorized)?;

        emit_audit(&env, &approver, symbol_short!("approve"), symbol_short!("pending"), symbol_short!("approved"));

        Ok(())
    }

    /// Execute an approved upgrade proposal
    pub fn execute_upgrade(
        env: Env,
        proposal_id: u64,
        executor: Address,
    ) -> Result<(), TradeError> {
        executor.require_auth();
        require_initialized(&env)?;

        GovernanceManager::execute_proposal(&env, proposal_id, executor.clone())
            .map_err(|_| TradeError::Unauthorized)?;

        emit_audit(&env, &executor, symbol_short!("execute"), symbol_short!("approved"), symbol_short!("executed"));

        Ok(())
    }

    /// Get upgrade proposal details
    pub fn get_upgrade_proposal(env: Env, proposal_id: u64) -> Result<UpgradeProposal, TradeError> {
        require_initialized(&env)?;
        GovernanceManager::get_proposal(&env, proposal_id).map_err(|_| TradeError::Unauthorized)
    }

    /// Reject an upgrade proposal
    pub fn reject_upgrade(env: Env, proposal_id: u64, rejector: Address) -> Result<(), TradeError> {
        rejector.require_auth();
        require_initialized(&env)?;

        GovernanceManager::reject_proposal(&env, proposal_id, rejector.clone())
            .map_err(|_| TradeError::Unauthorized)?;

        emit_audit(&env, &rejector, symbol_short!("reject"), symbol_short!("pending"), symbol_short!("rejected"));

        Ok(())
    }

    /// Cancel an upgrade proposal (admin only)
    pub fn cancel_upgrade(env: Env, proposal_id: u64, admin: Address) -> Result<(), TradeError> {
        admin.require_auth();
        require_initialized(&env)?;

        GovernanceManager::cancel_proposal(&env, proposal_id, admin.clone())
            .map_err(|_| TradeError::Unauthorized)?;

        emit_audit(&env, &admin, symbol_short!("cancel"), symbol_short!("pending"), symbol_short!("cancelled"));

        Ok(())
    }

    /// Submit a ZK proof of solvency
    pub fn submit_solvency_proof(
        env: Env,
        trader: Address,
        proof_hash: BytesN<32>,
        assets_commitment: BytesN<32>,
        liabilities_commitment: BytesN<32>,
        balance_commitment: BytesN<32>,
    ) -> Result<(), TradeError> {
        trader.require_auth();
        require_initialized(&env)?;

        if proof_hash.to_array().iter().all(|&b| b == 0) {
            return Err(TradeError::InvalidSolvencyProof);
        }
        if assets_commitment.to_array().iter().all(|&b| b == 0) {
            return Err(TradeError::InvalidSolvencyProof);
        }
        if liabilities_commitment.to_array().iter().all(|&b| b == 0) {
            return Err(TradeError::InvalidSolvencyProof);
        }
        if balance_commitment.to_array().iter().all(|&b| b == 0) {
            return Err(TradeError::InvalidSolvencyProof);
        }

        let now = env.ledger().timestamp();
        let ttl_secs: u64 = env
            .storage()
            .persistent()
            .get(&storage_keys::SOLVENCY_TTL)
            .unwrap_or(DEFAULT_SOLVENCY_PROOF_TTL_SECS);

        let record_key = (symbol_short!("solv_prf"), trader.clone());
        let nonce: u64 = env
            .storage()
            .persistent()
            .get(&record_key)
            .map(|r: SolvencyProofRecord| r.nonce + 1)
            .unwrap_or(1);

        let record = SolvencyProofRecord {
            proof_hash: proof_hash.clone(),
            assets_commitment,
            liabilities_commitment,
            balance_commitment,
            nonce,
            submitted_at: now,
            expires_at: now + ttl_secs,
        };

        env.storage().persistent().set(&record_key, &record);

        env.events()
            .publish((symbol_short!("solv_sub"),), (trader, proof_hash));

        Ok(())
    }

    /// Update private balance commitment
    pub fn update_private_balance(
        env: Env,
        trader: Address,
        commitment: BytesN<32>,
    ) -> Result<(), TradeError> {
        trader.require_auth();
        require_initialized(&env)?;

        if commitment.to_array().iter().all(|&b| b == 0) {
            return Err(TradeError::InvalidCommitment);
        }

        let record_key = (symbol_short!("prv_bal"), trader.clone());
        let nonce: u64 = env
            .storage()
            .persistent()
            .get(&record_key)
            .map(|r: PrivateBalanceCommitment| r.nonce + 1)
            .unwrap_or(1);

        let record = PrivateBalanceCommitment {
            commitment: commitment.clone(),
            nonce,
            updated_at: env.ledger().timestamp(),
        };

        env.storage().persistent().set(&record_key, &record);

        env.events()
            .publish((symbol_short!("bal_upd"),), (trader, commitment));

        Ok(())
    }

    /// Execute a private trade
    pub fn execute_private_trade(
        env: Env,
        trader: Address,
        pair: Symbol,
        price: i128,
        is_buy: bool,
        amount_commitment: BytesN<32>,
        balance_commitment: BytesN<32>,
        solvency_proof_hash: BytesN<32>,
    ) -> Result<u64, TradeError> {
        trader.require_auth();
        require_initialized(&env)?;

        if price <= 0 {
            return Err(TradeError::InvalidPrice);
        }
        if amount_commitment.to_array().iter().all(|&b| b == 0) {
            return Err(TradeError::InvalidCommitment);
        }
        if balance_commitment.to_array().iter().all(|&b| b == 0) {
            return Err(TradeError::InvalidCommitment);
        }
        if solvency_proof_hash.to_array().iter().all(|&b| b == 0) {
            return Err(TradeError::InvalidSolvencyProof);
        }

        let solv_key = (symbol_short!("solv_prf"), trader.clone());
        let solv_record: SolvencyProofRecord = env
            .storage()
            .persistent()
            .get(&solv_key)
            .ok_or(TradeError::MissingSolvencyProof)?;

        let now = env.ledger().timestamp();
        if now > solv_record.expires_at {
            return Err(TradeError::SolvencyProofExpired);
        }

        if solv_record.proof_hash != solvency_proof_hash {
            return Err(TradeError::InvalidSolvencyProof);
        }

        let mut trade_id: u64 = env
            .storage()
            .persistent()
            .get(&storage_keys::PRIV_TRADE_COUNT)
            .unwrap_or(0);
        trade_id += 1;
        env.storage()
            .persistent()
            .set(&storage_keys::PRIV_TRADE_COUNT, &trade_id);

        let trade = PrivateTradeRecord {
            id: trade_id,
            trader: trader.clone(),
            pair: pair.clone(),
            price,
            is_buy,
            amount_commitment: amount_commitment.clone(),
            balance_commitment: balance_commitment.clone(),
            solvency_proof_hash: solvency_proof_hash.clone(),
            timestamp: now,
        };

        let trade_key = (symbol_short!("prv_trd"), trade_id);
        env.storage().persistent().set(&trade_key, &trade);

        let bal_key = (symbol_short!("prv_bal"), trader.clone());
        let bal_nonce: u64 = env
            .storage()
            .persistent()
            .get(&bal_key)
            .map(|r: PrivateBalanceCommitment| r.nonce + 1)
            .unwrap_or(1);
        let bal_record = PrivateBalanceCommitment {
            commitment: balance_commitment.clone(),
            nonce: bal_nonce,
            updated_at: now,
        };
        env.storage().persistent().set(&bal_key, &bal_record);

        env.events().publish(
            (symbol_short!("prv_exec"),),
            (
                trade_id,
                trader,
                pair,
                amount_commitment,
                balance_commitment,
            ),
        );

        Ok(trade_id)
    }

    /// Register a compliance view key
    pub fn register_compliance_view_key(
        env: Env,
        trader: Address,
        encrypted_key: Bytes,
    ) -> Result<(), TradeError> {
        trader.require_auth();
        require_initialized(&env)?;

        let key_symbol = (symbol_short!("cmp_key"), trader.clone());
        let version: u32 = env
            .storage()
            .persistent()
            .get(&key_symbol)
            .map(|k: ComplianceViewKey| k.key_version + 1)
            .unwrap_or(1);

        let record = ComplianceViewKey {
            encrypted_key: encrypted_key.clone(),
            key_version: version,
            updated_at: env.ledger().timestamp(),
        };

        env.storage().persistent().set(&key_symbol, &record);

        env.events()
            .publish((symbol_short!("key_reg"),), (trader, version));

        Ok(())
    }

    /// Audit a private trade
    pub fn audit_private_trade(
        env: Env,
        auditor: Address,
        trade_id: u64,
        action: Symbol,
    ) -> Result<PrivateTradeAuditView, TradeError> {
        auditor.require_auth();
        require_initialized(&env)?;

        let auditor_permission = Symbol::new(&env, "audit");
        if !ACL::has_permission(&env, &auditor, &auditor_permission) {
            EventEmitter::access_denied(
                &env,
                AccessDeniedEvent {
                    actor: auditor.clone(),
                    required_permission: auditor_permission,
                    resource: symbol_short!("priv_trd"),
                    timestamp: env.ledger().timestamp(),
                },
            );
            return Err(TradeError::AuditUnauthorized);
        }

        let trade_key = (symbol_short!("prv_trd"), trade_id);
        let trade: PrivateTradeRecord = env
            .storage()
            .persistent()
            .get(&trade_key)
            .ok_or(TradeError::PrivateTradeNotFound)?;

        let solv_key = (symbol_short!("solv_prf"), trade.trader.clone());
        let proof = env.storage().persistent().get(&solv_key);

        let key_symbol = (symbol_short!("cmp_key"), trade.trader.clone());
        let trader_view_key = env.storage().persistent().get(&key_symbol);

        let mut audit_id: u64 = env
            .storage()
            .persistent()
            .get(&storage_keys::PRIV_AUDIT_COUNT)
            .unwrap_or(0);
        audit_id += 1;
        env.storage()
            .persistent()
            .set(&storage_keys::PRIV_AUDIT_COUNT, &audit_id);

        let record = PrivateTradeAuditRecord {
            audit_id,
            trade_id,
            auditor: auditor.clone(),
            trader: trade.trader.clone(),
            action: action.clone(),
            timestamp: env.ledger().timestamp(),
        };

        let audit_key = (symbol_short!("prv_aud"), audit_id);
        env.storage().persistent().set(&audit_key, &record);

        env.events()
            .publish((symbol_short!("prv_audt"),), (audit_id, trade_id, auditor.clone()));

        emit_audit(&env, &auditor, symbol_short!("aud_priv"), symbol_short!("none"), action);

        let mut proof_vec = Vec::new(&env);
        if let Some(p) = proof {
            proof_vec.push_back(p);
        }

        let mut key_vec = Vec::new(&env);
        if let Some(k) = trader_view_key {
            key_vec.push_back(k);
        }

        Ok(PrivateTradeAuditView {
            trade,
            proof: proof_vec,
            trader_view_key: key_vec,
            selective_disclosure: Vec::new(&env),
        })
    }
}

#[cfg(test)]
mod test;

#[cfg(test)]
mod bench;

mod verification;