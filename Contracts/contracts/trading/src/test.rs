
#[test]
fn test_pause_functionality() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TradingContract);
    let client = TradingContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    
    client.initialize(&admin);

    // Initial state: Not paused
    assert_eq!(client.is_paused(), false);

    // Pause the contract
    client.set_pause(&true);
    assert_eq!(client.is_paused(), true);

    // Try trade (should fail)
    let trader = Address::generate(&env);
    let fee_token = Address::generate(&env); // Just random address for now
    let recipient = Address::generate(&env);
    
    let res = client.try_trade(&trader, &fee_token, &100, &recipient);
    assert!(res.is_err());

    // Unpause
    client.set_pause(&false);
    assert_eq!(client.is_paused(), false);
    
    // Trade should fail with something else (like fee error) but NOT pause error
    // If we mock tokens it would succeed. 
    // Let's just check it is not the PAUSED error if we could match. 
    // Or we can just set up enough to pass past the pause check.
    // The pause check is the FIRST thing.
    // If we get past it, we hit FeeManager which might fail.
    
    // Let's set up tokens so trade succeeds
    let issuer = Address::generate(&env);
    let token_contract_id = env.register_stellar_asset_contract(issuer);
    let token_admin_client = token::StellarAssetClient::new(&env, &token_contract_id);
    token_admin_client.mint(&trader, &1000);

    let res_ok = client.try_trade(&trader, &token_contract_id, &100, &recipient);
    assert!(res_ok.is_ok());
}
