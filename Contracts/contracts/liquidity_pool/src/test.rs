
#[test]
fn test_pause_functionality() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, LiquidityPool);
    let client = LiquidityPoolClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    
    let token_admin = Address::generate(&env);
    let staking_token = env.register_stellar_asset_contract(token_admin.clone());
    let reward_token = env.register_stellar_asset_contract(token_admin.clone());

    client.initialize(&admin, &staking_token, &reward_token, &100);

    // Initial state: Not paused
    assert_eq!(client.is_paused(), false);

    // Pause the contract
    client.set_pause(&true);
    assert_eq!(client.is_paused(), true);

    // Try deposit (should fail)
    let user = Address::generate(&env);
    let res = client.try_deposit(&user, &100);
    assert!(res.is_err());
    
    // Try withdraw (should fail)
    let res_withdraw = client.try_withdraw(&user, &100);
    assert!(res_withdraw.is_err());

    // Unpause
    client.set_pause(&false);
    assert_eq!(client.is_paused(), false);

    // Deposit should work now 
    let staking_admin_client = token::StellarAssetClient::new(&env, &staking_token);
    staking_admin_client.mint(&user, &1000);
    
    let res_deposit_ok = client.try_deposit(&user, &100);
    assert!(res_deposit_ok.is_ok());
}
