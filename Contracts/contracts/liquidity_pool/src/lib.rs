#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, token};

use shared::fees::{FeeManager, FeeError};
use shared::safe_call::{safe_invoke, errors as SafeCallErrors};
use shared::errors::PAUSED;

#[contracttype]
#[derive(Clone)]
pub struct PoolInfo {
    pub total_staked: i128,
    pub acc_reward_per_share: i128, // Scaled by 1e12
    pub last_reward_time: u64,
    pub reward_rate: i128,          // Rewards per second
}

#[contracttype]
#[derive(Clone)]
pub struct UserInfo {
    pub amount: i128,
    pub reward_debt: i128,
}

#[contracttype]
pub enum DataKey {
    Config,      // ContractConfig
    PoolInfo,    // PoolInfo
    User(Address), // UserInfo
    StakingToken,
    RewardToken,
    Admin,
    Paused,
}

const PRECISION: i128 = 1_000_000_000_000; // 1e12

#[contract]
pub struct LiquidityPool;

#[contractimpl]
impl LiquidityPool {
    pub fn initialize(
        env: Env, 
        admin: Address, 
        staking_token: Address, 
        reward_token: Address, 
        reward_rate: i128
    ) {
        if env.storage().instance().has(&DataKey::Config) {
            panic!("Already initialized");
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::StakingToken, &staking_token);
        env.storage().instance().set(&DataKey::RewardToken, &reward_token);
        env.storage().instance().set(&DataKey::Paused, &false);

        let pool_info = PoolInfo {
            total_staked: 0,
            acc_reward_per_share: 0,
            last_reward_time: env.ledger().timestamp(),
            reward_rate,
        };
        env.storage().instance().set(&DataKey::PoolInfo, &pool_info);
    }

    pub fn deposit(env: Env, user: Address, amount: i128) {
        }

        Self::update_pool(&env);

        let mut pool = Self::get_pool_info(&env);
        let mut user_info = Self::get_user_info(&env, &user);

        // Transfer tokens from user to contract
        let staking_token: Address = env.storage().instance().get(&DataKey::StakingToken).unwrap();
        let token_client = token::Client::new(&env, &staking_token);
        token_client.transfer(&user, &env.current_contract_address(), &amount);

        // Calculate pending rewards before changing stake
        if user_info.amount > 0 {
            let pending = (user_info.amount * pool.acc_reward_per_share) / PRECISION - user_info.reward_debt;
            if pending > 0 {
                let reward_token: Address = env.storage().instance().get(&DataKey::RewardToken).unwrap();
                let reward_client = token::Client::new(&env, &reward_token);
                reward_client.transfer(&env.current_contract_address(), &user, &pending);
            }
        }

        // Update user info
        user_info.amount += amount;
        user_info.reward_debt = (user_info.amount * pool.acc_reward_per_share) / PRECISION;
        
        // Update pool info
        pool.total_staked += amount;

        env.storage().instance().set(&DataKey::User(user.clone()), &user_info);
        env.storage().instance().set(&DataKey::PoolInfo, &pool);
    }

    pub fn withdraw(env: Env, user: Address, amount: i128) {
        if Self::is_paused(env.clone()) {
            panic!("{}", PAUSED);
        }
        user.require_auth();
        if amount <= 0 {
            panic!("Invalid amount");
        }

        Self::update_pool(&env);

        let mut pool = Self::get_pool_info(&env);
        let mut user_info = Self::get_user_info(&env, &user);

        if user_info.amount < amount {
            panic!("Insufficient stake");
        }

        // Calculate pending rewards
        let pending = (user_info.amount * pool.acc_reward_per_share) / PRECISION - user_info.reward_debt;
        if pending > 0 {
            let reward_token: Address = env.storage().instance().get(&DataKey::RewardToken).unwrap();
            let reward_client = token::Client::new(&env, &reward_token);
            reward_client.transfer(&env.current_contract_address(), &user, &pending);
        }

        // Transfer staked tokens back
        let staking_token: Address = env.storage().instance().get(&DataKey::StakingToken).unwrap();
        let token_client = token::Client::new(&env, &staking_token);
        token_client.transfer(&env.current_contract_address(), &user, &amount);

        // Update user info
        user_info.amount -= amount;
        user_info.reward_debt = (user_info.amount * pool.acc_reward_per_share) / PRECISION;

        // Update pool info
        pool.total_staked -= amount;

        env.storage().instance().set(&DataKey::User(user.clone()), &user_info);
        env.storage().instance().set(&DataKey::PoolInfo, &pool);
    }

    pub fn get_pending_rewards(env: Env, user: Address) -> i128 {
        let pool = Self::get_pool_info(&env);
        let user_info = Self::get_user_info(&env, &user);
        let acc_reward_per_share = pool.acc_reward_per_share;

        // Simulate update_pool logic for view function
        let current_time = env.ledger().timestamp();
        let mut adjusted_acc_reward_per_share = acc_reward_per_share;

        if current_time > pool.last_reward_time && pool.total_staked != 0 {
            let time_elapsed = (current_time - pool.last_reward_time) as i128;
            let rewards = time_elapsed * pool.reward_rate;
            adjusted_acc_reward_per_share += (rewards * PRECISION) / pool.total_staked;
        }

        (user_info.amount * adjusted_acc_reward_per_share) / PRECISION - user_info.reward_debt
    }

    // Internal helper to update pool variables
    fn update_pool(env: &Env) {
        let mut pool = Self::get_pool_info(env);
        let current_time = env.ledger().timestamp();

        if current_time <= pool.last_reward_time {
            return;
        }

        if pool.total_staked == 0 {
            pool.last_reward_time = current_time;
            env.storage().instance().set(&DataKey::PoolInfo, &pool);
            return;
        }

        let time_elapsed = (current_time - pool.last_reward_time) as i128;
        let rewards = time_elapsed * pool.reward_rate;
        
        pool.acc_reward_per_share += (rewards * PRECISION) / pool.total_staked;
        pool.last_reward_time = current_time;

        env.storage().instance().set(&DataKey::PoolInfo, &pool);
    }

    fn get_pool_info(env: &Env) -> PoolInfo {
        env.storage().instance().get(&DataKey::PoolInfo).unwrap()
    }

    fn get_user_info(env: &Env, user: &Address) -> UserInfo {
        env.storage().instance().get(&DataKey::User(user.clone())).unwrap_or(UserInfo {
            amount: 0,
            reward_debt: 0,
        })
    }

    pub fn set_pause(env: Env, paused: bool) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &paused);
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }
}

#[cfg(test)]
mod test;
