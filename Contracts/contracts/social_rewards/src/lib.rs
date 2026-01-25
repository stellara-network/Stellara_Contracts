#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env};

#[contract]
pub struct SocialRewardsContract;

#[contractimpl]
impl SocialRewardsContract {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
    }

    /// Adds a reward. Fails if amount is 0 (to simulate validation logic).
    pub fn add_reward(env: Env, user: Address, amount: i128) {
        if Self::is_paused(env.clone()) {
            panic!("{}", PAUSED);
        }
        if amount <= 0 {
            panic!("Invalid reward amount");
        }
        // Logic to store reward would go here.
        // For testing, we just succeed or panic.
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
