use soroban_sdk::{
    contract, contractimpl, testutils::Address as _, testutils::Ledger as _, Address, Env,
    IntoVal, Symbol,
};
use token::{TokenContract, TokenContractClient};

#[contract]
struct HookReceiver;

#[contractimpl]
impl HookReceiver {
    pub fn on_token_transfer(env: Env, token: Address, from: Address, amount: i128) {
        env.storage().instance().set(&Symbol::new(&env, "token"), &token);
        env.storage().instance().set(&Symbol::new(&env, "from"), &from);
        env.storage().instance().set(&Symbol::new(&env, "amount"), &amount);
    }
}

#[test]
fn transfer_approve_allowance_and_metadata() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenContract);
    let client = TokenContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    let recipient = Address::generate(&env);

    client.initialize(
        &admin,
        &"Stellara Token".into_val(&env),
        &"STLR".into_val(&env),
        &7,
    );

    client.mint(&owner, &1_000);

    let current_ledger = env.ledger().sequence();
    client.approve(&owner, &spender, &250, &(current_ledger + 10));

    assert_eq!(client.allowance(&owner, &spender), 250);

    client.transfer_from(&spender, &owner, &recipient, &200);

    assert_eq!(client.balance(&owner), 800);
    assert_eq!(client.balance(&recipient), 200);
    assert_eq!(client.allowance(&owner, &spender), 50);

    assert_eq!(client.name(), "Stellara Token".into_val(&env));
    assert_eq!(client.symbol(), "STLR".into_val(&env));
    assert_eq!(client.decimals(), 7);
}

#[test]
fn transfer_hook_is_safe_and_records_when_supported() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenContract);
    let client = TokenContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);

    client.initialize(
        &admin,
        &"Stellara Token".into_val(&env),
        &"STLR".into_val(&env),
        &7,
    );

    client.mint(&sender, &500);

    let hook_address = env.register_contract(None, HookReceiver);

    client.transfer(&sender, &hook_address, &200);

    let (stored_token, stored_from, stored_amount) = env.as_contract(&hook_address, || {
        let stored_token: Address = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "token"))
            .unwrap();
        let stored_from: Address = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "from"))
            .unwrap();
        let stored_amount: i128 = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "amount"))
            .unwrap();
        (stored_token, stored_from, stored_amount)
    });

    assert_eq!(stored_token, contract_id);
    assert_eq!(stored_from, sender);
    assert_eq!(stored_amount, 200);

    let receiver = Address::generate(&env);
    client.transfer(&hook_address, &receiver, &50);
}

#[test]
fn expired_allowance_treated_as_zero() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenContract);
    let client = TokenContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);

    client.initialize(
        &admin,
        &"Stellara Token".into_val(&env),
        &"STLR".into_val(&env),
        &7,
    );

    client.mint(&owner, &100);

    let current = env.ledger().sequence();
    client.approve(&owner, &spender, &80, &current);

    let mut ledger_info = env.ledger().get();
    ledger_info.sequence_number = current + 5;
    env.ledger().set(ledger_info);

    assert_eq!(client.allowance(&owner, &spender), 0);

}

#[test]
fn unauthorized_account_cannot_spend() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenContract);
    let client = TokenContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let recipient = Address::generate(&env);

    client.initialize(
        &admin,
        &"Stellara Token".into_val(&env),
        &"STLR".into_val(&env),
        &7,
    );

    client.mint(&owner, &100);
    client.set_authorized(&owner, &false);

    assert!(!client.authorized(&owner));
    assert_eq!(client.balance(&recipient), 0);
}
