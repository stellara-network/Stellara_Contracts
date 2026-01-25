#![cfg(test)]

use super::*;
use soroban_sdk::{Env, testutils::Address as _};

#[test]
fn test_pause_functionality() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, SocialRewardsContract);
    let client = SocialRewardsContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    
    client.initialize(&admin);

    // Initial state: Not paused
    assert_eq!(client.is_paused(), false);

    // Pause the contract
    client.set_pause(&true);
    assert_eq!(client.is_paused(), true);

    // Try add_reward (should fail)
    let user = Address::generate(&env);
    let res = client.try_add_reward(&user, &100);
    assert!(res.is_err());

    // Unpause
    client.set_pause(&false);
    assert_eq!(client.is_paused(), false);
    
    // Should succeed now
    let res_ok = client.try_add_reward(&user, &100);
    assert!(res_ok.is_ok());
}
