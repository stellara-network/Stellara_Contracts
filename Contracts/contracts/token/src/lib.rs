#![no_std]

use soroban_sdk::{
    contract, contractimpl, panic_with_error, symbol_short, vec, Address, Env, IntoVal,
    InvokeError, String, Symbol, Val, Vec,
};

mod admin;
mod error;
mod storage;

use error::TokenError;
pub use storage::TokenMetadata;
use storage::AllowanceData;

#[contract]
pub struct TokenContract;

#[contractimpl]
impl TokenContract {
    pub fn initialize(env: Env, admin: Address, name: String, symbol: String, decimals: u32) {
        if storage::has_admin(&env) {
            panic_with_error!(&env, TokenError::AlreadyInitialized);
        }
        admin.require_auth();
        storage::set_admin(&env, &admin);
        storage::set_metadata(
            &env,
            &TokenMetadata {
                name,
                symbol,
                decimals,
            },
        );
    }

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        storage::allowance_amount(&env, &from, &spender)
    }

    pub fn approve(env: Env, from: Address, spender: Address, amount: i128, expiration_ledger: u32) {
        from.require_auth();

        if amount < 0 {
            panic_with_error!(&env, TokenError::InvalidAmount);
        }

        let current_ledger = env.ledger().sequence();
        if amount > 0 && expiration_ledger < current_ledger {
            panic_with_error!(&env, TokenError::ExpirationInPast);
        }

        let data = AllowanceData {
            amount,
            expiration_ledger,
        };
        storage::set_allowance(&env, &from, &spender, &data);

        env.events().publish(
            (symbol_short!("approve"), from, spender),
            (amount, expiration_ledger),
        );
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        storage::balance_of(&env, &id)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        Self::transfer_balance(&env, &from, &to, amount);
        Self::invoke_transfer_hook(&env, &from, &to, amount);
    }

    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();

        if amount < 0 {
            panic_with_error!(&env, TokenError::InvalidAmount);
        }

        let allowance = storage::allowance_amount(&env, &from, &spender);
        if allowance < amount {
            panic_with_error!(&env, TokenError::InsufficientAllowance);
        }

        storage::set_allowance(
            &env,
            &from,
            &spender,
            &AllowanceData {
                amount: allowance - amount,
                expiration_ledger: storage::allowance_expiration(&env, &from, &spender),
            },
        );

        Self::transfer_balance(&env, &from, &to, amount);
        Self::invoke_transfer_hook(&env, &from, &to, amount);
    }

    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        Self::burn_balance(&env, &from, amount);

        env.events()
            .publish((symbol_short!("burn"), from), amount);
    }

    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();

        if amount < 0 {
            panic_with_error!(&env, TokenError::InvalidAmount);
        }

        let allowance = storage::allowance_amount(&env, &from, &spender);
        if allowance < amount {
            panic_with_error!(&env, TokenError::InsufficientAllowance);
        }

        storage::set_allowance(
            &env,
            &from,
            &spender,
            &AllowanceData {
                amount: allowance - amount,
                expiration_ledger: storage::allowance_expiration(&env, &from, &spender),
            },
        );

        Self::burn_balance(&env, &from, amount);

        env.events()
            .publish((symbol_short!("burn"), from), amount);
    }

    pub fn decimals(env: Env) -> u32 {
        storage::metadata(&env).decimals
    }

    pub fn name(env: Env) -> String {
        storage::metadata(&env).name
    }

    pub fn symbol(env: Env) -> String {
        storage::metadata(&env).symbol
    }

    pub fn metadata(env: Env) -> TokenMetadata {
        storage::metadata(&env)
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        admin::require_admin(&env);
        let previous_admin = storage::admin(&env);
        storage::set_admin(&env, &new_admin);

        env.events().publish(
            (symbol_short!("set_admin"), previous_admin),
            new_admin,
        );
    }

    pub fn admin(env: Env) -> Address {
        storage::admin(&env)
    }

    pub fn set_authorized(env: Env, id: Address, authorize: bool) {
        admin::require_admin(&env);
        storage::set_authorized(&env, &id, authorize);

        env.events().publish(
            (Symbol::new(&env, "set_authorized"), id),
            authorize,
        );
    }

    pub fn authorized(env: Env, id: Address) -> bool {
        storage::authorized(&env, &id)
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        admin::require_admin(&env);
        Self::mint_balance(&env, &to, amount);

        let admin = storage::admin(&env);
        env.events().publish((symbol_short!("mint"), admin, to), amount);
    }

    pub fn clawback(env: Env, from: Address, amount: i128) {
        admin::require_admin(&env);
        Self::burn_balance(&env, &from, amount);

        let admin = storage::admin(&env);
        env.events()
            .publish((symbol_short!("clawback"), admin, from), amount);
    }

    fn transfer_balance(env: &Env, from: &Address, to: &Address, amount: i128) {
        if amount < 0 {
            panic_with_error!(env, TokenError::InvalidAmount);
        }

        if !storage::authorized(env, from) || !storage::authorized(env, to) {
            panic_with_error!(env, TokenError::NotAuthorized);
        }

        let from_balance = storage::balance_of(env, from);
        if from_balance < amount {
            panic_with_error!(env, TokenError::InsufficientBalance);
        }

        let new_from = from_balance.checked_sub(amount).unwrap_or_else(|| {
            panic_with_error!(env, TokenError::ArithmeticOverflow);
        });
        let to_balance = storage::balance_of(env, to);
        let new_to = to_balance.checked_add(amount).unwrap_or_else(|| {
            panic_with_error!(env, TokenError::ArithmeticOverflow);
        });

        storage::set_balance(env, from, new_from);
        storage::set_balance(env, to, new_to);

        env.events()
            .publish((symbol_short!("transfer"), from.clone(), to.clone()), amount);
    }

    fn burn_balance(env: &Env, from: &Address, amount: i128) {
        if amount < 0 {
            panic_with_error!(env, TokenError::InvalidAmount);
        }

        if !storage::authorized(env, from) {
            panic_with_error!(env, TokenError::NotAuthorized);
        }

        let balance = storage::balance_of(env, from);
        if balance < amount {
            panic_with_error!(env, TokenError::InsufficientBalance);
        }

        let new_balance = balance.checked_sub(amount).unwrap_or_else(|| {
            panic_with_error!(env, TokenError::ArithmeticOverflow);
        });
        storage::set_balance(env, from, new_balance);
    }

    fn mint_balance(env: &Env, to: &Address, amount: i128) {
        if amount < 0 {
            panic_with_error!(env, TokenError::InvalidAmount);
        }

        if !storage::authorized(env, to) {
            panic_with_error!(env, TokenError::NotAuthorized);
        }

        let balance = storage::balance_of(env, to);
        let new_balance = balance.checked_add(amount).unwrap_or_else(|| {
            panic_with_error!(env, TokenError::ArithmeticOverflow);
        });
        storage::set_balance(env, to, new_balance);
    }

    fn invoke_transfer_hook(env: &Env, from: &Address, to: &Address, amount: i128) {
        let func = Symbol::new(env, "on_token_transfer");
        let args: Vec<Val> = vec![
            env,
            from.clone().into_val(env),
            amount.into_val(env),
            env.current_contract_address().into_val(env),
        ];

        let _ = env.try_invoke_contract::<(), InvokeError>(to, &func, args);
    }
}
