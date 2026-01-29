use soroban_sdk::{testutils::Address as _, Address, Env, IntoVal};
use token::{TokenContract, TokenContractClient};

#[test]
fn mint_overflow_attack() {
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

    client.mint(&admin, &i128::MAX);
    assert_eq!(client.total_supply(), i128::MAX);
}
