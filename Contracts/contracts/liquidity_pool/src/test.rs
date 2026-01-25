#![cfg(test)]

use super::*;
use soroban_sdk::{Env, testutils::{Address as _, Ledger}, token};

#[test]
fn test_rewards_flow() {
    let env = Env::default();
    env.mock_all_auths();

    // Setup Contracts
    let contract_id = env.register_contract(None, LiquidityPool);
    let client = LiquidityPoolClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    
    // Setup Tokens
    let token_admin = Address::generate(&env);
    let staking_token = env.register_stellar_asset_contract(token_admin.clone());
    let reward_token = env.register_stellar_asset_contract(token_admin.clone());
    
    let staking_client = token::Client::new(&env, &staking_token);
    let staking_admin_client = token::StellarAssetClient::new(&env, &staking_token);
    
    let reward_client = token::Client::new(&env, &reward_token);
    let reward_admin_client = token::StellarAssetClient::new(&env, &reward_token);

    // Initialize Pool
    // Reward rate = 10 tokens per second
    let reward_rate = 10;
    client.initialize(&admin, &staking_token, &reward_token, &reward_rate);

    // Fund the pool with rewards (so it can pay out)
    reward_admin_client.mint(&env.current_contract_address(), &100_000);

    // User 1 Setup
    let user1 = Address::generate(&env);
    staking_admin_client.mint(&user1, &1000);

    // 1. User 1 Deposits 100
    client.deposit(&user1, &100);
    assert_eq!(staking_client.balance(&user1), 900);
    assert_eq!(staking_client.balance(&env.current_contract_address()), 100);

    // Advance time by 10 seconds
    // Rewards should be: 10 sec * 10 rate = 100 tokens
    // User 1 has 100% share. Should get 100 tokens.
    let start_time = env.ledger().timestamp();
    env.ledger().set_timestamp(start_time + 10);

    // Check pending rewards
    let pending = client.get_pending_rewards(&user1);
    assert_eq!(pending, 100);

    // 2. User 1 Withdraws
    // Should receive 100 rewards + 100 stake
    let pre_reward_balance = reward_client.balance(&user1);
    client.withdraw(&user1, &100);
    
    assert_eq!(reward_client.balance(&user1), pre_reward_balance + 100);
    assert_eq!(staking_client.balance(&user1), 1000);
}

#[test]
fn test_multiple_users() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, LiquidityPool);
    let client = LiquidityPoolClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    
    let token_admin = Address::generate(&env);
    let staking_token = env.register_stellar_asset_contract(token_admin.clone());
    let reward_token = env.register_stellar_asset_contract(token_admin.clone());
    let staking_admin = token::StellarAssetClient::new(&env, &staking_token);
    let reward_admin = token::StellarAssetClient::new(&env, &reward_token);

    // Initialize: 100 rewards per second
    client.initialize(&admin, &staking_token, &reward_token, &100);
    reward_admin.mint(&env.current_contract_address(), &1_000_000);

    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    staking_admin.mint(&user1, &1000);
    staking_admin.mint(&user2, &1000);

    // T=0: User 1 deposits 100
    client.deposit(&user1, &100);

    // T=10: User 2 deposits 100
    // User 1 was alone for 10s. Rewards: 10 * 100 = 1000.
    let start_time = env.ledger().timestamp();
    env.ledger().set_timestamp(start_time + 10);
    
    client.deposit(&user2, &100);
    
    // Check Pending for User 1 (should be 1000)
    assert_eq!(client.get_pending_rewards(&user1), 1000);
    // User 2 just joined, 0 pending
    assert_eq!(client.get_pending_rewards(&user2), 0);

    // T=20: 10s passed. Total stake = 200.
    // Rewards generated: 10 * 100 = 1000.
    // Split 50/50. Each gets 500.
    // User 1 Total: 1000 + 500 = 1500.
    // User 2 Total: 0 + 500 = 500.
    env.ledger().set_timestamp(start_time + 20);

    assert_eq!(client.get_pending_rewards(&user1), 1500);
    assert_eq!(client.get_pending_rewards(&user2), 500);
}
