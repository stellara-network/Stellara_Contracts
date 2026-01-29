#[cfg(test)]
mod test {
    use crate::{AcademyRewardsContract, AcademyRewardsContractClient, ContractError};
    use soroban_sdk::{testutils::Address as _, Address, Env, String};

    #[test]
    fn test_initialization() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, AcademyRewardsContract);
        let client = AcademyRewardsContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);

        client.initialize(&admin);
    }

    #[test]
    fn test_badge_lifecycle() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, AcademyRewardsContract);
        let client = AcademyRewardsContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        client.initialize(&admin);

        // Create badge type
        client.create_badge_type(
            &admin,
            &1,
            &String::from_str(&env, "Bronze"),
            &500, // 5% discount
            &10,  // 10 max redemptions
            &0,   // Never expires
        );

        // Mint badge
        client.mint_badge(&admin, &user, &1);

        // Check discount
        let discount = client.get_user_discount(&user);
        assert_eq!(discount, 500);

        // Get badge info
        let badge = client.get_user_badge(&user).unwrap();
        assert_eq!(badge.badge_type, 1);
        assert_eq!(badge.discount_bps, 500);
        assert_eq!(badge.redeemed_count, 0);

        // Check total minted
        let total = client.get_total_minted(&1);
        assert_eq!(total, 1);
    }

    #[test]
    fn test_redemption() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, AcademyRewardsContract);
        let client = AcademyRewardsContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        client.initialize(&admin);

        client.create_badge_type(
            &admin,
            &1,
            &String::from_str(&env, "Bronze"),
            &500,
            &3, // 3 max redemptions
            &0,
        );

        client.mint_badge(&admin, &user, &1);

        // Redeem badge
        let tx_hash = String::from_str(&env, "tx_001");
        let discount = client.redeem_badge(&user, &tx_hash);

        assert_eq!(discount, 500);

        // Check updated badge
        let badge = client.get_user_badge(&user).unwrap();
        assert_eq!(badge.redeemed_count, 1);

        // Check redemption history
        let history = client.get_redemption_history(&user, &0).unwrap();
        assert_eq!(history.badge_type, 1);
        assert_eq!(history.discount_applied, 500);
    }

    #[test]
    fn test_prevent_double_redemption() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, AcademyRewardsContract);
        let client = AcademyRewardsContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        client.initialize(&admin);
        client.create_badge_type(&admin, &1, &String::from_str(&env, "Bronze"), &500, &10, &0);
        client.mint_badge(&admin, &user, &1);

        let tx_hash = String::from_str(&env, "tx_001");

        // First redemption - should succeed
        client.redeem_badge(&user, &tx_hash);

        // Second redemption with same tx_hash - should fail with TransactionAlreadyRedeemed error
        let result = client.try_redeem_badge(&user, &tx_hash);
        
        assert_eq!(result, Err(Ok(ContractError::TransactionAlreadyRedeemed)));
    }

    #[test]
    fn test_redemption_limit() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, AcademyRewardsContract);
        let client = AcademyRewardsContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        client.initialize(&admin);
        client.create_badge_type(
            &admin,
            &1,
            &String::from_str(&env, "Bronze"),
            &500,
            &2, // Only 2 redemptions allowed
            &0,
        );

        client.mint_badge(&admin, &user, &1);

        // Redeem twice successfully
        let tx1 = String::from_str(&env, "tx_001");
        client.redeem_badge(&user, &tx1);

        let tx2 = String::from_str(&env, "tx_002");
        client.redeem_badge(&user, &tx2);

        // Third redemption should fail with RedemptionLimitReached error
        let tx3 = String::from_str(&env, "tx_003");
        let result = client.try_redeem_badge(&user, &tx3);
        
        assert_eq!(result, Err(Ok(ContractError::RedemptionLimitReached)));
    }

    #[test]
    fn test_revoke_badge() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, AcademyRewardsContract);
        let client = AcademyRewardsContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        client.initialize(&admin);
        client.create_badge_type(&admin, &1, &String::from_str(&env, "Bronze"), &500, &10, &0);
        client.mint_badge(&admin, &user, &1);

        // Badge is active
        let discount = client.get_user_discount(&user);
        assert_eq!(discount, 500);

        // Revoke badge
        client.revoke_badge(&admin, &user);

        // Badge should no longer give discount
        let discount = client.get_user_discount(&user);
        assert_eq!(discount, 0);
    }
}