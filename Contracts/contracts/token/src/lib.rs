#![no_std]

use soroban_sdk::{
    contract, contractimpl, Address, Env, Error, IntoVal, String, Symbol, Val, Vec,
};

mod admin;
mod storage;

use storage::{Allowance, TokenMetadata};

#[contract]
pub struct TokenContract;

#[contractimpl]
impl TokenContract {
    /// Initialize token metadata and admin.
    pub fn initialize(env: Env, admin: Address, name: String, symbol: String, decimals: u32) {
        if storage::has_admin(&env) {
            panic!("Already initialized");
        }
        admin.require_auth();
        storage::set_admin(&env, &admin);
        storage::set_metadata(&env, &TokenMetadata { name, symbol, decimals });
        storage::set_total_supply(&env, 0);
    }

    // --------- Standard token interface ---------
    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        storage::get_allowance_amount(&env, &from, &spender)
    }

    pub fn approve(env: Env, from: Address, spender: Address, amount: i128, expiration_ledger: u32) {
        from.require_auth();
        ensure_nonnegative(amount);

        let current_ledger = env.ledger().sequence();
        if expiration_ledger < current_ledger && amount != 0 {
            panic!("Invalid expiration");
        }

        let allowance = Allowance {
            amount,
            expiration_ledger,
        };
        storage::set_allowance(&env, &from, &spender, &allowance);

        env.events().publish(
            (Symbol::new(&env, "approve"), from, spender),
            (amount, expiration_ledger),
        );
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        storage::balance_of(&env, &id)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        ensure_nonnegative(amount);
        require_authorized(&env, &from);

        internal_transfer(&env, &from, &to, amount);
    }

    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        ensure_nonnegative(amount);
        require_authorized(&env, &from);

        spend_allowance(&env, &from, &spender, amount);
        internal_transfer(&env, &from, &to, amount);
    }

    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        ensure_nonnegative(amount);
        require_authorized(&env, &from);

        burn_balance(&env, &from, amount);
        env.events()
            .publish((Symbol::new(&env, "burn"), from), amount);
    }

    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        ensure_nonnegative(amount);
        require_authorized(&env, &from);

        spend_allowance(&env, &from, &spender, amount);
        burn_balance(&env, &from, amount);
        env.events()
            .publish((Symbol::new(&env, "burn"), from), amount);
    }

    pub fn decimals(env: Env) -> u32 {
        storage::get_metadata(&env).decimals
    }

    pub fn name(env: Env) -> String {
        storage::get_metadata(&env).name
    }

    pub fn symbol(env: Env) -> String {
        storage::get_metadata(&env).symbol
    }

    // --------- Admin interface ---------
    pub fn set_admin(env: Env, new_admin: Address) {
        let current_admin = storage::get_admin(&env);
        current_admin.require_auth();
        storage::set_admin(&env, &new_admin);
        env.events().publish(
            (Symbol::new(&env, "set_admin"), current_admin),
            new_admin,
        );
    }

    pub fn admin(env: Env) -> Address {
        storage::get_admin(&env)
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
        storage::get_authorized(&env, &id)
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        admin::require_admin(&env);
        ensure_nonnegative(amount);

        let balance = storage::balance_of(&env, &to);
        let new_balance = balance.checked_add(amount).expect("Overflow");
        storage::set_balance(&env, &to, &new_balance);

        let supply = storage::total_supply(&env);
        let new_supply = supply.checked_add(amount).expect("Overflow");
        storage::set_total_supply(&env, new_supply);

        env.events().publish(
            (Symbol::new(&env, "mint"), storage::get_admin(&env), to),
            amount,
        );
    }

    pub fn clawback(env: Env, from: Address, amount: i128) {
        admin::require_admin(&env);
        ensure_nonnegative(amount);

        burn_balance(&env, &from, amount);
        env.events().publish(
            (Symbol::new(&env, "clawback"), storage::get_admin(&env), from),
            amount,
        );
    }

    // --------- Additional helpers ---------
    pub fn total_supply(env: Env) -> i128 {
        storage::total_supply(&env)
    }
}

fn ensure_nonnegative(amount: i128) {
    if amount < 0 {
        panic!("Negative amount");
    }
}

fn require_authorized(env: &Env, id: &Address) {
    if !storage::get_authorized(env, id) {
        panic!("Unauthorized");
    }
}

fn spend_allowance(env: &Env, from: &Address, spender: &Address, amount: i128) {
    let allowance = storage::get_allowance(env, from, spender);
    let current_ledger = env.ledger().sequence();

    let available = if allowance.expiration_ledger < current_ledger {
        0
    } else {
        allowance.amount
    };

    if amount > available {
        panic!("Allowance exceeded");
    }

    let remaining = available.checked_sub(amount).expect("Overflow");
    let updated = Allowance {
        amount: remaining,
        expiration_ledger: allowance.expiration_ledger,
    };
    storage::set_allowance(env, from, spender, &updated);
}

fn burn_balance(env: &Env, from: &Address, amount: i128) {
    let balance = storage::balance_of(env, from);
    if amount > balance {
        panic!("Insufficient balance");
    }

    let new_balance = balance.checked_sub(amount).expect("Overflow");
    storage::set_balance(env, from, &new_balance);

    let supply = storage::total_supply(env);
    let new_supply = supply.checked_sub(amount).expect("Overflow");
    storage::set_total_supply(env, new_supply);
}

fn internal_transfer(env: &Env, from: &Address, to: &Address, amount: i128) {
    if amount == 0 || from == to {
        return;
    }

    let from_balance = storage::balance_of(env, from);
    if amount > from_balance {
        panic!("Insufficient balance");
    }

    let to_balance = storage::balance_of(env, to);

    let new_from = from_balance.checked_sub(amount).expect("Overflow");
    let new_to = to_balance.checked_add(amount).expect("Overflow");

    storage::set_balance(env, from, &new_from);
    storage::set_balance(env, to, &new_to);

    env.events()
        .publish((Symbol::new(env, "transfer"), from, to), amount);

    invoke_transfer_hook(env, from, to, amount);
}

fn invoke_transfer_hook(env: &Env, from: &Address, to: &Address, amount: i128) {
    let func = Symbol::new(env, "on_token_transfer");
    let mut args = Vec::new(env);
    args.push_back(env.current_contract_address().into_val(env));
    args.push_back(from.clone().into_val(env));
    args.push_back(amount.into_val(env));

    let _ = env.try_invoke_contract::<Val, Error>(to, &func, args);
}
