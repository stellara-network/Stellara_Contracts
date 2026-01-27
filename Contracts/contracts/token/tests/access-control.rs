use soroban_sdk::{testutils::Address as _, testutils::Ledger, Address, Env, String};

use token::{TokenContract, TokenContractClient, TokenMetadata};

fn setup_token(env: &Env) -> (Address, Address, TokenContractClient) {
    env.mock_all_auths();

    let admin = Address::generate(env);
    let contract_id = env.register_contract(None, TokenContract);
    let client = TokenContractClient::new(env, &contract_id);

    client.initialize(
        &admin,
        &String::from_str(env, "Stellara"),
        &String::from_str(env, "STLR"),
        &7u32,
    );

    (admin, contract_id, client)
}

#[test]
fn metadata_and_views_match() {
    let env = Env::default();
    let (_admin, _token_id, client) = setup_token(&env);

    assert_eq!(client.name(), String::from_str(&env, "Stellara"));
    assert_eq!(client.symbol(), String::from_str(&env, "STLR"));
    assert_eq!(client.decimals(), 7);

    let metadata = client.metadata();
    assert_eq!(
        metadata,
        TokenMetadata {
            name: String::from_str(&env, "Stellara"),
            symbol: String::from_str(&env, "STLR"),
            decimals: 7,
        }
    );
}

#[test]
fn transfer_updates_balances() {
    let env = Env::default();
    let (_admin, _token_id, client) = setup_token(&env);

    let owner = Address::generate(&env);
    let recipient = Address::generate(&env);

    client.mint(&owner, &1_000i128);
    client.transfer(&owner, &recipient, &250i128);

    assert_eq!(client.balance(&owner), 750);
    assert_eq!(client.balance(&recipient), 250);
}

#[test]
fn approve_and_transfer_from_consumes_allowance() {
    let env = Env::default();
    let (_admin, _token_id, client) = setup_token(&env);

    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    let recipient = Address::generate(&env);

    client.mint(&owner, &1_000i128);

    env.ledger().with_mut(|li| {
        li.sequence_number = 100;
    });

    client.approve(&owner, &spender, &300i128, &200u32);
    assert_eq!(client.allowance(&owner, &spender), 300);

    client.transfer_from(&spender, &owner, &recipient, &200i128);

    assert_eq!(client.allowance(&owner, &spender), 100);
    assert_eq!(client.balance(&owner), 800);
    assert_eq!(client.balance(&recipient), 200);
}
