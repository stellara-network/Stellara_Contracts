use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, Address, Env, IntoVal};
use token::{TokenContract, TokenContractClient};

#[test]
fn standard_conformance_transfer_and_balance() {
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

    client.mint(&owner, &1_000);
    client.transfer(&owner, &recipient, &200);

    assert_eq!(client.balance(&owner), 800);
    assert_eq!(client.balance(&recipient), 200);
}

#[test]
fn standard_conformance_approve_allowance_transfer_from() {
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

    let current = env.ledger().sequence();
    client.approve(&owner, &spender, &300, &(current + 5));
    assert_eq!(client.allowance(&owner, &spender), 300);

    client.transfer_from(&spender, &owner, &recipient, &150);

    assert_eq!(client.balance(&owner), 850);
    assert_eq!(client.balance(&recipient), 150);
    assert_eq!(client.allowance(&owner, &spender), 150);
}

#[test]
fn standard_conformance_metadata() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenContract);
    let client = TokenContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);

    client.initialize(
        &admin,
        &"Stellara Token".into_val(&env),
        &"STLR".into_val(&env),
        &7,
    );

    assert_eq!(client.name(), "Stellara Token".into_val(&env));
    assert_eq!(client.symbol(), "STLR".into_val(&env));
    assert_eq!(client.decimals(), 7);
}

#[test]
fn standard_conformance_expired_allowance_is_zero() {
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
    client.approve(&owner, &spender, &80, &(current + 1));

    let mut ledger_info = env.ledger().get();
    ledger_info.sequence_number = current + 2;
    env.ledger().set(ledger_info);
    assert_eq!(client.allowance(&owner, &spender), 0);

    // Avoid calling transfer_from with expired allowance since the contract panics.
}
