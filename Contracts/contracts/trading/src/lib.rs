#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol, IntoVal, Vec, Val};
use shared::fees::{FeeManager, FeeError};
use shared::safe_call::{safe_invoke, errors as SafeCallErrors};
use shared::errors::PAUSED;

#[contracttype]
pub enum DataKey {
    Admin,
    Paused,
}

#[contract]
pub struct TradingContract;

#[contractimpl]
impl TradingContract {
    /// Executes a trade and collects a fee.
    pub fn trade(
        env: Env, 
        trader: Address, 
        fee_token: Address, 
        fee_amount: i128,
        fee_recipient: Address
    ) -> Result<(), FeeError> {
        trader.require_auth();

        // Collect Fee First
        // If this fails (e.g. insufficient balance), it returns FeeError, 
        // and the transaction is gracefully failed (reverted) with that error.
        FeeManager::collect_fee(&env, &fee_token, &trader, &fee_recipient, fee_amount)?;

        // Perform Trade Logic (Placeholder)
        // ...
        
        Ok(())
    }

    /// Executes a trade and then triggers a reward in another contract.
    /// Demonstrates atomicity: if reward fails, trade (fee) should be rolled back.
    pub fn trade_and_reward(
        env: Env,
        trader: Address,
        fee_token: Address,
        fee_amount: i128,
        fee_recipient: Address,
        reward_contract: Address,
        reward_amount: i128,
    ) -> Result<(), u32> {
        if Self::is_paused(env.clone()) {
            panic!("{}", PAUSED);
        }
        trader.require_auth();

        // 1. Collect Fee (State Change 1)
        // We map FeeError to u32 for simplicity in this demo, or we could use a custom enum
        match FeeManager::collect_fee(&env, &fee_token, &trader, &fee_recipient, fee_amount) {
            Ok(_) => {},
            Err(e) => return Err(e as u32),
        }

        // 2. Call Reward Contract (Cross-Contract Call)
        // We use safe_invoke to wrap the call.
        // If this returns Err, we bubble it up.
        // If we bubble up an Err, Soroban reverts the WHOLE transaction, undoing Step 1.
        let args: Vec<Val> = (trader.clone(), reward_amount).into_val(&env);
        
        // Note: In Soroban, if the sub-call panics (e.g. invalid amount), 
        // `try_invoke_contract` catches it if we use that. 
        // `safe_invoke` uses `try_invoke_contract`.
        // If `safe_invoke` returns Err, we return Err, causing top-level revert.
        match safe_invoke(&env, &reward_contract, &Symbol::new(&env, "add_reward"), args) {
            Ok(_) => Ok(()),
            Err(code) => Err(code),
        }
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
