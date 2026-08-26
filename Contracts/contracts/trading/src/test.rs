#![cfg(test)]

use super::*;
use shared::circuit_breaker::CircuitBreakerConfig;
use shared::governance::ProposalStatus;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger},
    vec, Address, Env, Vec,
};

// Use the auto-generated client from #[contractimpl]
use crate::UpgradeableTradingContractClient;

fn setup_contract(
    env: &Env,
) -> (
    UpgradeableTradingContractClient<'_>,
    Address,
    Address,
    Address,
) {
    let contract_id = env.register_contract(None, UpgradeableTradingContract);
    let client = UpgradeableTradingContractClient::new(env, &contract_id);

    let admin = Address::generate(env);
    let approver = Address::generate(env);
    let executor = Address::generate(env);

    let mut approvers = Vec::new(env);
    approvers.push_back(approver.clone());

    let cb_config = CircuitBreakerConfig {
        max_volume_per_period: 1_000_000_000i128,
        max_tx_count_per_period: 100u64,
        period_duration: 3600u64,
    };

    env.mock_all_auths();
    client.init(&admin, &approvers, &executor, &cb_config);

    (client, admin, approver, executor)
}

#[test]
fn test_contract_initialization() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let contract_id = env.register_contract(None, UpgradeableTradingContract);
    let client = UpgradeableTradingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let approver = Address::generate(&env);
    let executor = Address::generate(&env);

    let cb_config = CircuitBreakerConfig {
        max_volume_per_period: 10_000_000i128,
        max_tx_count_per_period: 10u64,
        period_duration: 3600u64,
    };

    let mut approvers = Vec::new(&env);
    approvers.push_back(approver.clone());

    client.init(&admin, &approvers, &executor, &cb_config);

    let version = client.get_version();
    assert_eq!(version, 1);
}

#[test]
fn test_contract_cannot_be_initialized_twice() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let contract_id = env.register_contract(None, UpgradeableTradingContract);
    let client = UpgradeableTradingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let approver = Address::generate(&env);
    let executor = Address::generate(&env);

    let cb_config = CircuitBreakerConfig {
        max_volume_per_period: 10_000_000i128,
        max_tx_count_per_period: 10u64,
        period_duration: 3600u64,
    };

    let mut approvers = Vec::new(&env);
    approvers.push_back(approver.clone());

    client.init(&admin, &approvers, &executor, &cb_config);

    let result = client.try_init(&admin, &approvers, &executor, &cb_config);
    assert!(result.is_err());
}

#[test]
fn test_upgrade_proposal_creation() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, admin, approver, _executor) = setup_contract(&env);

    let mut approvers = Vec::new(&env);
    approvers.push_back(approver.clone());

    let new_hash = symbol_short!("v2hash");
    let description = symbol_short!("Upgrade");
    let proposal_id =
        client.propose_upgrade(&admin, &new_hash, &description, &approvers, &1u32, &3600u64);

    assert_eq!(proposal_id, 1);

    let prop = client.get_upgrade_proposal(&1u64);
    assert_eq!(prop.id, 1);
    assert_eq!(prop.approvals_count, 0);
    assert_eq!(prop.status, ProposalStatus::Pending);
}

#[test]
fn test_upgrade_proposal_approval_flow() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let contract_id = env.register_contract(None, UpgradeableTradingContract);
    let client = UpgradeableTradingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let approver1 = Address::generate(&env);
    let approver2 = Address::generate(&env);
    let executor = Address::generate(&env);

    let mut approvers = Vec::new(&env);
    approvers.push_back(approver1.clone());
    approvers.push_back(approver2.clone());

    let cb_config = CircuitBreakerConfig {
        max_volume_per_period: 10_000_000i128,
        max_tx_count_per_period: 10u64,
        period_duration: 3600u64,
    };

    client.init(&admin, &approvers, &executor, &cb_config);

    let new_hash = symbol_short!("v2hash");
    let description = symbol_short!("Upgrade");
    let proposal_id =
        client.propose_upgrade(&admin, &new_hash, &description, &approvers, &2u32, &3600u64);

    client.approve_upgrade(&proposal_id, &approver1);
    let prop = client.get_upgrade_proposal(&proposal_id);
    assert_eq!(prop.approvals_count, 1);
    assert_eq!(prop.status, ProposalStatus::Pending);

    client.approve_upgrade(&proposal_id, &approver2);
    let prop = client.get_upgrade_proposal(&proposal_id);
    assert_eq!(prop.approvals_count, 2);
    assert_eq!(prop.status, ProposalStatus::Approved);
}

#[test]
fn test_upgrade_timelock_enforcement() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, admin, approver, executor) = setup_contract(&env);

    let mut approvers = Vec::new(&env);
    approvers.push_back(approver.clone());

    let proposal_id = client.propose_upgrade(
        &admin,
        &symbol_short!("v2hash"),
        &symbol_short!("Upgrade"),
        &approvers,
        &1u32,
        &14400u64,
    );

    client.approve_upgrade(&proposal_id, &approver);

    let execute_result = client.try_execute_upgrade(&proposal_id, &executor);
    assert!(execute_result.is_err());

    env.ledger().with_mut(|li| li.timestamp = 1000 + 14401);

    client.execute_upgrade(&proposal_id, &executor);

    let prop = client.get_upgrade_proposal(&proposal_id);
    assert_eq!(prop.status, ProposalStatus::Executed);
    assert!(prop.executed);
}

#[test]
fn test_upgrade_rejection_flow() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, admin, approver, _executor) = setup_contract(&env);

    let mut approvers = Vec::new(&env);
    approvers.push_back(approver.clone());

    let proposal_id = client.propose_upgrade(
        &admin,
        &symbol_short!("v2hash"),
        &symbol_short!("Upgrade"),
        &approvers,
        &1u32,
        &3600u64,
    );

    client.reject_upgrade(&proposal_id, &approver);

    let prop = client.get_upgrade_proposal(&proposal_id);
    assert_eq!(prop.status, ProposalStatus::Rejected);
}

#[test]
fn test_upgrade_cancellation_by_admin() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, admin, approver, _executor) = setup_contract(&env);

    let mut approvers = Vec::new(&env);
    approvers.push_back(approver.clone());

    let proposal_id = client.propose_upgrade(
        &admin,
        &symbol_short!("v2hash"),
        &symbol_short!("Upgrade"),
        &approvers,
        &1u32,
        &3600u64,
    );

    client.cancel_upgrade(&proposal_id, &admin);

    let prop = client.get_upgrade_proposal(&proposal_id);
    assert_eq!(prop.status, ProposalStatus::Cancelled);
}

#[test]
fn test_multi_sig_protection() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let contract_id = env.register_contract(None, UpgradeableTradingContract);
    let client = UpgradeableTradingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let approver1 = Address::generate(&env);
    let approver2 = Address::generate(&env);
    let approver3 = Address::generate(&env);
    let executor = Address::generate(&env);

    let mut approvers = Vec::new(&env);
    approvers.push_back(approver1.clone());
    approvers.push_back(approver2.clone());
    approvers.push_back(approver3.clone());

    let cb_config = CircuitBreakerConfig {
        max_volume_per_period: 10_000_000i128,
        max_tx_count_per_period: 10u64,
        period_duration: 3600u64,
    };

    client.init(&admin, &approvers, &executor, &cb_config);

    let proposal_id = client.propose_upgrade(
        &admin,
        &symbol_short!("v2hash"),
        &symbol_short!("Upgrade"),
        &approvers,
        &2u32,
        &3600u64,
    );

    let prop = client.get_upgrade_proposal(&proposal_id);
    assert_eq!(prop.approval_threshold, 2);

    client.approve_upgrade(&proposal_id, &approver1);
    let prop = client.get_upgrade_proposal(&proposal_id);
    assert_eq!(prop.approvals_count, 1);
    assert_eq!(prop.status, ProposalStatus::Pending);

    client.approve_upgrade(&proposal_id, &approver2);
    let prop = client.get_upgrade_proposal(&proposal_id);
    assert_eq!(prop.approvals_count, 2);
    assert_eq!(prop.status, ProposalStatus::Approved);
}

#[test]
fn test_duplicate_approval_prevention() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, admin, approver, _executor) = setup_contract(&env);

    let proposal_id = client.propose_upgrade(
        &admin,
        &symbol_short!("v2hash"),
        &symbol_short!("Upgrade"),
        &vec![&env, approver.clone()],
        &1u32,
        &3600u64,
    );

    client.approve_upgrade(&proposal_id, &approver);

    let result = client.try_approve_upgrade(&proposal_id, &approver);
    assert!(result.is_err());
}

// ============ OPTIMIZED TRADING TESTS ============

#[test]
fn test_optimized_trade_execution() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, _admin, _approver, _executor) = setup_contract(&env);

    let trader = Address::generate(&env);
    let fee_recipient = Address::generate(&env);

    let token_id = env.register_stellar_asset_contract(fee_recipient.clone());

    let trade_id = client.trade(
        &trader,
        &symbol_short!("BTCUSD"),
        &1_000_000i128,
        &50_000i128,
        &true,
        &token_id,
        &0i128,
        &fee_recipient,
        &1_000_000_000i128, // pool_liquidity
    );

    assert_eq!(trade_id, 1);

    let stats = client.get_stats();
    assert_eq!(stats.total_trades, 1);
    assert_eq!(stats.total_volume, 1_000_000);
}

#[test]
fn test_optimized_trade_signed_amount() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, _admin, _approver, _executor) = setup_contract(&env);

    let trader = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(fee_recipient.clone());

    let buy_id = client.trade(
        &trader,
        &symbol_short!("BTCUSD"),
        &1_000_000i128,
        &50_000i128,
        &true,
        &token_id,
        &0i128,
        &fee_recipient,
        &1_000_000_000i128, // pool_liquidity
    );

    let sell_id = client.trade(
        &trader,
        &symbol_short!("BTCUSD"),
        &500_000i128,
        &50_000i128,
        &false,
        &token_id,
        &0i128,
        &fee_recipient,
        &1_000_000_000i128, // pool_liquidity
    );

    assert_eq!(buy_id, 1);
    assert_eq!(sell_id, 2);

    let stats = client.get_stats();
    assert_eq!(stats.total_trades, 2);
    assert_eq!(stats.total_volume, 1_500_000);
}

#[test]
fn test_optimized_get_trade() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, _admin, _approver, _executor) = setup_contract(&env);

    let trader = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(fee_recipient.clone());

    let trade_id = client.trade(
        &trader,
        &symbol_short!("BTCUSD"),
        &1_000_000i128,
        &50_000i128,
        &true,
        &token_id,
        &0i128,
        &fee_recipient,
        &1_000_000_000i128, // pool_liquidity
    );

    let trade = client.get_trade(&trade_id);
    assert!(trade.is_some());

    let trade = trade.unwrap();
    assert_eq!(trade.id, 1);
    assert_eq!(trade.signed_amount, 1_000_000);
    assert_eq!(trade.price, 50_000);
}

#[test]
fn test_optimized_get_recent_trades() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, _admin, _approver, _executor) = setup_contract(&env);

    let trader = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(fee_recipient.clone());

    for i in 1..=5 {
        let trade_id = client.trade(
            &trader,
            &symbol_short!("BTCUSD"),
            &(i as i128 * 100_000),
            &50_000i128,
            &true,
            &token_id,
            &0i128,
            &fee_recipient,
            &1_000_000_000i128, // pool_liquidity
        );
        assert_eq!(trade_id, i as u64);
    }

    let recent = client.get_recent_trades(&3u32);
    assert_eq!(recent.len(), 3);

    assert_eq!(recent.get(0).unwrap().id, 3);
    assert_eq!(recent.get(1).unwrap().id, 4);
    assert_eq!(recent.get(2).unwrap().id, 5);
}

#[test]
fn test_optimized_pause_unpause() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, admin, _approver, _executor) = setup_contract(&env);

    let trader = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(fee_recipient.clone());

    client.pause(&admin);

    let result = client.try_trade(
        &trader,
        &symbol_short!("BTCUSD"),
        &1_000_000i128,
        &50_000i128,
        &true,
        &token_id,
        &0i128,
        &fee_recipient,
        &1_000_000_000i128, // pool_liquidity
    );
    assert!(result.is_err());

    client.unpause(&admin);

    let trade_id = client.trade(
        &trader,
        &symbol_short!("BTCUSD"),
        &1_000_000i128,
        &50_000i128,
        &true,
        &token_id,
        &0i128,
        &fee_recipient,
        &1_000_000_000i128, // pool_liquidity
    );
    assert_eq!(trade_id, 1);
}

#[test]
fn test_optimized_storage_scaling() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, _admin, _approver, _executor) = setup_contract(&env);

    let trader = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(fee_recipient.clone());

    for i in 1..=20 {
        let trade_id = client.trade(
            &trader,
            &symbol_short!("BTCUSD"),
            &(i as i128 * 100_000),
            &50_000i128,
            &(i % 2 == 0),
            &token_id,
            &0i128,
            &fee_recipient,
            &1_000_000_000i128, // pool_liquidity
        );
        assert_eq!(trade_id, i as u64);
    }

    let stats = client.get_stats();
    assert_eq!(stats.total_trades, 20);

    let trade_10 = client.get_trade(&10u64);
    assert!(trade_10.is_some());
    assert_eq!(trade_10.unwrap().id, 10);
}

// ============ BATCH OPERATION TESTS ============

#[test]
fn test_batch_trade_execution() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, _admin, _approver, _executor) = setup_contract(&env);

    let trader = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(fee_recipient.clone());

    let mut orders = Vec::new(&env);
    orders.push_back((symbol_short!("BTCUSD"), 1_000_000i128, 50_000i128, true));
    orders.push_back((symbol_short!("ETHUSD"), 500_000i128, 3_000i128, true));
    orders.push_back((symbol_short!("BTCUSD"), 200_000i128, 49_500i128, false));

    let trade_ids = client.batch_trade(&trader, &orders, &token_id, &0i128, &fee_recipient);

    assert_eq!(trade_ids.len(), 3);
    assert_eq!(trade_ids.get(0).unwrap(), 1);
    assert_eq!(trade_ids.get(1).unwrap(), 2);
    assert_eq!(trade_ids.get(2).unwrap(), 3);

    let stats = client.get_stats();
    assert_eq!(stats.total_trades, 3);
    assert_eq!(stats.total_volume, 1_700_000);
}

#[test]
fn test_batch_trade_empty_orders() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, _admin, _approver, _executor) = setup_contract(&env);

    let trader = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(fee_recipient.clone());

    let orders = Vec::new(&env);

    let trade_ids = client.batch_trade(&trader, &orders, &token_id, &0i128, &fee_recipient);

    assert_eq!(trade_ids.len(), 0);
}

#[test]
fn test_batch_trade_invalid_amount() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, _admin, _approver, _executor) = setup_contract(&env);

    let trader = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(fee_recipient.clone());

    let mut orders = Vec::new(&env);
    orders.push_back((symbol_short!("BTCUSD"), 1_000_000i128, 50_000i128, true));
    orders.push_back((symbol_short!("ETHUSD"), -500_000i128, 3_000i128, true));

    let result = client.try_batch_trade(&trader, &orders, &token_id, &0i128, &fee_recipient);

    assert!(result.is_err());
    let stats = client.get_stats();
    assert_eq!(stats.total_trades, 0);
    assert_eq!(stats.total_volume, 0);
}

#[test]
fn test_batch_trade_rejects_oversized_batch() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, _admin, _approver, _executor) = setup_contract(&env);

    let trader = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(fee_recipient.clone());

    let mut orders = Vec::new(&env);
    for i in 0..client.max_batch_size() + 1 {
        orders.push_back((symbol_short!("BTCUSD"), 1000 + i as i128, 50_000i128, true));
    }

    let result = client.try_batch_trade(&trader, &orders, &token_id, &0i128, &fee_recipient);

    assert!(result.is_err());
    let stats = client.get_stats();
    assert_eq!(stats.total_trades, 0);
}

#[test]
fn test_trade_batch_alias_matches_batch_trade() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, _admin, _approver, _executor) = setup_contract(&env);

    let trader = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(fee_recipient.clone());

    let orders = vec![
        &env,
        (symbol_short!("BTCUSD"), 1_000_000i128, 50_000i128, true),
        (symbol_short!("ETHUSD"), 500_000i128, 3_000i128, true),
    ];

    let trade_ids = client.trade_batch(&trader, &orders, &token_id, &0i128, &fee_recipient);
    assert_eq!(trade_ids.len(), 2);
    assert_eq!(trade_ids.get(0).unwrap(), 1);
}

#[test]
fn test_batch_trade_gas_efficiency() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, _admin, _approver, _executor) = setup_contract(&env);

    let trader = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(fee_recipient.clone());

    env.budget().reset_default();
    for i in 0..3 {
        client.trade(
            &trader,
            &symbol_short!("BTCUSD"),
            &(1_000_000i128 + i as i128),
            &50_000i128,
            &true,
            &token_id,
            &0i128,
            &fee_recipient,
            &1_000_000_000i128, // pool_liquidity
        );
    }
    let _individual_cpu = env.budget().cpu_instruction_cost();

    let contract_id = env.register_contract(None, UpgradeableTradingContract);
    let client2 = UpgradeableTradingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let approver = Address::generate(&env);
    let executor = Address::generate(&env);
    let mut approvers = Vec::new(&env);
    approvers.push_back(approver);
    let cb_config = CircuitBreakerConfig {
        max_volume_per_period: 1_000_000_000i128,
        max_tx_count_per_period: 100u64,
        period_duration: 3600u64,
    };
    client2.init(&admin, &approvers, &executor, &cb_config);

    env.budget().reset_default();
    let mut orders = Vec::new(&env);
    for i in 0..3 {
        orders.push_back((
            symbol_short!("BTCUSD"),
            1_000_000i128 + i as i128,
            50_000i128,
            true,
        ));
    }
    client2.trade_batch(&trader, &orders, &token_id, &0i128, &fee_recipient);
    let _batch_cpu = env.budget().cpu_instruction_cost();
}

#[test]
fn test_optimized_storage_access_pattern() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, _admin, _approver, _executor) = setup_contract(&env);

    let trader = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(fee_recipient.clone());

    env.budget().reset_default();
    let trade_id = client.trade(
        &trader,
        &symbol_short!("BTCUSD"),
        &1_000_000i128,
        &50_000i128,
        &true,
        &token_id,
        &0i128,
        &fee_recipient,
        &1_000_000_000i128, // pool_liquidity
    );

    let _cpu_cost = env.budget().cpu_instruction_cost();
    let _mem_cost = env.budget().memory_bytes_cost();

    assert_eq!(trade_id, 1);
    let stats = client.get_stats();
    assert_eq!(stats.total_trades, 1);
}

// ============ LIMIT ORDER TESTS ============

#[test]
fn test_create_limit_order() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, _admin, _approver, _executor) = setup_contract(&env);
    let trader = Address::generate(&env);

    let order_id = client.create_limit_order(
        &trader,
        &symbol_short!("BTCUSD"),
        &true,
        &50_000i128,
        &1_000i128,
        &TimeInForce::Gtc,
        &1_000_000_000i128, // pool_liquidity
    );

    assert_eq!(order_id, 1);

    let order = client.get_order(&order_id).unwrap();
    assert_eq!(order.id, 1);
    assert_eq!(order.price, 50_000);
    assert_eq!(order.amount, 1_000);
    assert_eq!(order.remaining, 1_000);
    assert_eq!(order.status, OrderStatus::Open);
    assert_eq!(order.side, OrderSide::Buy);

    let book = client.get_open_orders(&symbol_short!("BTCUSD"), &true);
    assert_eq!(book.len(), 1);
    assert_eq!(book.get(0).unwrap().id, 1);
}

#[test]
fn test_cancel_order() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, _admin, _approver, _executor) = setup_contract(&env);
    let trader = Address::generate(&env);

    let order_id = client.create_limit_order(
        &trader,
        &symbol_short!("BTCUSD"),
        &true,
        &50_000i128,
        &1_000i128,
        &TimeInForce::Gtc,
        &1_000_000_000i128, // pool_liquidity
    );

    client.cancel_order(&trader, &order_id);

    let order = client.get_order(&order_id).unwrap();
    assert_eq!(order.status, OrderStatus::Cancelled);

    let book = client.get_open_orders(&symbol_short!("BTCUSD"), &true);
    assert_eq!(book.len(), 0);
}

#[test]
fn test_limit_order_matching_full_fill() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, _admin, _approver, _executor) = setup_contract(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);

    let sell_order_id = client.create_limit_order(
        &seller,
        &symbol_short!("BTCUSD"),
        &false,
        &50_000i128,
        &1_000i128,
        &TimeInForce::Gtc,
        &1_000_000_000i128, // pool_liquidity
    );

    let buy_order_id = client.create_limit_order(
        &buyer,
        &symbol_short!("BTCUSD"),
        &true,
        &50_000i128,
        &1_000i128,
        &TimeInForce::Gtc,
        &1_000_000_000i128, // pool_liquidity
    );

    let sell_order = client.get_order(&sell_order_id).unwrap();
    let buy_order = client.get_order(&buy_order_id).unwrap();

    assert_eq!(sell_order.status, OrderStatus::Filled);
    assert_eq!(buy_order.status, OrderStatus::Filled);
    assert_eq!(sell_order.remaining, 0);
    assert_eq!(buy_order.remaining, 0);

    let buy_book = client.get_open_orders(&symbol_short!("BTCUSD"), &true);
    let sell_book = client.get_open_orders(&symbol_short!("BTCUSD"), &false);
    assert_eq!(buy_book.len(), 0);
    assert_eq!(sell_book.len(), 0);

    let stats = client.get_stats();
    assert_eq!(stats.total_trades, 2);
    assert_eq!(stats.total_volume, 2_000);
}

#[test]
fn test_limit_order_partial_fill() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, _admin, _approver, _executor) = setup_contract(&env);
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);

    let sell_order_id = client.create_limit_order(
        &seller,
        &symbol_short!("BTCUSD"),
        &false,
        &50_000i128,
        &2_000i128,
        &TimeInForce::Gtc,
        &1_000_000_000i128, // pool_liquidity
    );

    let buy_order_id = client.create_limit_order(
        &buyer,
        &symbol_short!("BTCUSD"),
        &true,
        &50_000i128,
        &500i128,
        &TimeInForce::Gtc,
        &1_000_000_000i128, // pool_liquidity
    );

    let sell_order = client.get_order(&sell_order_id).unwrap();
    let buy_order = client.get_order(&buy_order_id).unwrap();

    assert_eq!(buy_order.status, OrderStatus::Filled);
    assert_eq!(buy_order.remaining, 0);

    assert_eq!(sell_order.status, OrderStatus::PartiallyFilled);
    assert_eq!(sell_order.remaining, 1_500);

    let sell_book = client.get_open_orders(&symbol_short!("BTCUSD"), &false);
    assert_eq!(sell_book.len(), 1);
    assert_eq!(sell_book.get(0).unwrap().id, sell_order_id);
}

#[test]
fn test_ioc_order_cancels_unfilled_remainder() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, _admin, _approver, _executor) = setup_contract(&env);
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);

    client.create_limit_order(
        &seller,
        &symbol_short!("BTCUSD"),
        &false,
        &50_000i128,
        &400i128,
        &TimeInForce::Gtc,
        &1_000_000_000i128, // pool_liquidity
    );

    let buy_order_id = client.create_limit_order(
        &buyer,
        &symbol_short!("BTCUSD"),
        &true,
        &50_000i128,
        &1_000i128,
        &TimeInForce::Ioc,
        &1_000_000_000i128, // pool_liquidity
    );

    let buy_order = client.get_order(&buy_order_id).unwrap();
    assert_eq!(buy_order.status, OrderStatus::Cancelled);
    assert_eq!(buy_order.remaining, 600);

    let buy_book = client.get_open_orders(&symbol_short!("BTCUSD"), &true);
    assert_eq!(buy_book.len(), 0);
}

#[test]
fn test_fok_order_requires_full_liquidity() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, _admin, _approver, _executor) = setup_contract(&env);
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);

    client.create_limit_order(
        &seller,
        &symbol_short!("BTCUSD"),
        &false,
        &50_000i128,
        &400i128,
        &TimeInForce::Gtc,
        &1_000_000_000i128, // pool_liquidity
    );

    let result = client.try_create_limit_order(
        &buyer,
        &symbol_short!("BTCUSD"),
        &true,
        &50_000i128,
        &1_000i128,
        &TimeInForce::Fok,
        &1_000_000_000i128, // pool_liquidity
    );

    assert!(result.is_err());

    let stats = client.get_stats();
    assert_eq!(stats.total_trades, 0);
}

#[test]
fn test_fok_order_executes_when_fully_fillable() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1000);
    env.mock_all_auths();

    let (client, _admin, _approver, _executor) = setup_contract(&env);
    let seller1 = Address::generate(&env);
    let seller2 = Address::generate(&env);
    let buyer = Address::generate(&env);

    client.create_limit_order(
        &seller1,
        &symbol_short!("BTCUSD"),
        &false,
        &50_000i128,
        &400i128,
        &TimeInForce::Gtc,
        &1_000_000_000i128, // pool_liquidity
    );

    client.create_limit_order(
        &seller2,
        &symbol_short!("BTCUSD"),
        &false,
        &50_000i128,
        &600i128,
        &TimeInForce::Gtc,
        &1_000_000_000i128, // pool_liquidity
    );

    let buy_order_id = client.create_limit_order(
        &buyer,
        &symbol_short!("BTCUSD"),
        &true,
        &50_000i128,
        &1_000i128,
        &TimeInForce::Fok,
        &1_000_000_000i128, // pool_liquidity
    );

    let buy_order = client.get_order(&buy_order_id).unwrap();
    assert_eq!(buy_order.status, OrderStatus::Filled);
    assert_eq!(buy_order.remaining, 0);

    let sell_book = client.get_open_orders(&symbol_short!("BTCUSD"), &false);
    assert_eq!(sell_book.len(), 0);

    let stats = client.get_stats();
    assert_eq!(stats.total_trades, 4);
    assert_eq!(stats.total_volume, 2_000);
}
