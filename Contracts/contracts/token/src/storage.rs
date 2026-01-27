use soroban_sdk::{contracttype, Address, Env, String};

#[contracttype]
pub enum DataKey {
    Admin,
    Metadata,
    Balance(Address),
    Allowance(Address, Address),
    Authorized(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllowanceData {
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenMetadata {
    pub name: String,
    pub symbol: String,
    pub decimals: u32,
}

pub fn has_admin(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Admin)
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}

pub fn admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("Admin not set")
}

pub fn set_metadata(env: &Env, metadata: &TokenMetadata) {
    env.storage().instance().set(&DataKey::Metadata, metadata);
}

pub fn metadata(env: &Env) -> TokenMetadata {
    env.storage()
        .instance()
        .get(&DataKey::Metadata)
        .expect("Metadata not set")
}

pub fn balance_of(env: &Env, id: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Balance(id.clone()))
        .unwrap_or(0)
}

pub fn set_balance(env: &Env, id: &Address, amount: i128) {
    let key = DataKey::Balance(id.clone());
    if amount == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &amount);
    }
}

pub fn allowance_amount(env: &Env, from: &Address, spender: &Address) -> i128 {
    let key = DataKey::Allowance(from.clone(), spender.clone());
    let data: Option<AllowanceData> = env.storage().persistent().get(&key);
    match data {
        Some(allowance) => {
            if is_allowance_expired(env, &allowance) {
                env.storage().persistent().remove(&key);
                0
            } else {
                allowance.amount
            }
        }
        None => 0,
    }
}

pub fn allowance_expiration(env: &Env, from: &Address, spender: &Address) -> u32 {
    let key = DataKey::Allowance(from.clone(), spender.clone());
    let data: Option<AllowanceData> = env.storage().persistent().get(&key);
    match data {
        Some(allowance) => {
            if is_allowance_expired(env, &allowance) {
                env.storage().persistent().remove(&key);
                0
            } else {
                allowance.expiration_ledger
            }
        }
        None => 0,
    }
}

pub fn set_allowance(env: &Env, from: &Address, spender: &Address, data: &AllowanceData) {
    let key = DataKey::Allowance(from.clone(), spender.clone());
    if data.amount == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, data);
    }
}

pub fn set_authorized(env: &Env, id: &Address, authorize: bool) {
    env.storage()
        .persistent()
        .set(&DataKey::Authorized(id.clone()), &authorize);
}

pub fn authorized(env: &Env, id: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::Authorized(id.clone()))
        .unwrap_or(true)
}

fn is_allowance_expired(env: &Env, allowance: &AllowanceData) -> bool {
    let current_ledger = env.ledger().sequence();
    allowance.expiration_ledger < current_ledger
}
