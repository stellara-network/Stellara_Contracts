use soroban_sdk::{contracttype, Address, Env, String};

#[contracttype]
#[derive(Clone, Debug)]
pub struct AllowanceKey {
    pub from: Address,
    pub spender: Address,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Allowance {
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct TokenMetadata {
    pub name: String,
    pub symbol: String,
    pub decimals: u32,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Metadata,
    TotalSupply,
    Balance(Address),
    Allowance(AllowanceKey),
    Authorized(Address),
}

pub fn has_admin(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Admin)
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}

pub fn get_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("Admin not set")
}

pub fn set_metadata(env: &Env, metadata: &TokenMetadata) {
    env.storage().instance().set(&DataKey::Metadata, metadata);
}

pub fn get_metadata(env: &Env) -> TokenMetadata {
    env.storage()
        .instance()
        .get(&DataKey::Metadata)
        .expect("Metadata not set")
}

pub fn set_total_supply(env: &Env, total: i128) {
    env.storage().instance().set(&DataKey::TotalSupply, &total);
}

pub fn total_supply(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::TotalSupply)
        .unwrap_or(0)
}

pub fn balance_of(env: &Env, id: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Balance(id.clone()))
        .unwrap_or(0)
}

pub fn set_balance(env: &Env, id: &Address, amount: &i128) {
    if *amount == 0 {
        env.storage().persistent().remove(&DataKey::Balance(id.clone()));
    } else {
        env.storage()
            .persistent()
            .set(&DataKey::Balance(id.clone()), amount);
    }
}

pub fn set_allowance(env: &Env, from: &Address, spender: &Address, allowance: &Allowance) {
    let key = DataKey::Allowance(AllowanceKey {
        from: from.clone(),
        spender: spender.clone(),
    });
    env.storage().persistent().set(&key, allowance);
}

pub fn get_allowance(env: &Env, from: &Address, spender: &Address) -> Allowance {
    let key = DataKey::Allowance(AllowanceKey {
        from: from.clone(),
        spender: spender.clone(),
    });
    env.storage().persistent().get(&key).unwrap_or(Allowance {
        amount: 0,
        expiration_ledger: 0,
    })
}

pub fn get_allowance_amount(env: &Env, from: &Address, spender: &Address) -> i128 {
    let allowance = get_allowance(env, from, spender);
    let current_ledger = env.ledger().sequence();
    if allowance.expiration_ledger < current_ledger {
        0
    } else {
        allowance.amount
    }
}

pub fn set_authorized(env: &Env, id: &Address, authorized: bool) {
    env.storage()
        .persistent()
        .set(&DataKey::Authorized(id.clone()), &authorized);
}

pub fn get_authorized(env: &Env, id: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::Authorized(id.clone()))
        .unwrap_or(true)
}
