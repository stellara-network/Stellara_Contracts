// Regression test for gas/performance optimizations
#[cfg(test)]
mod regression {
    use super::*;
    use soroban_sdk::{testutils::*, Address, Env};

    #[test]
    fn test_grant_and_claim_regression() {
        let env = Env::default();
        let admin = Address::random(&env);
        let reward_token = Address::random(&env);
        let governance = Address::random(&env);
        let beneficiary = Address::random(&env);
        AcademyVestingContract::init(env.clone(), admin.clone(), reward_token.clone(), governance.clone()).unwrap();
        let grant_id = AcademyVestingContract::grant_vesting(env.clone(), admin.clone(), beneficiary.clone(), 1000, 0, 0, 1000).unwrap();
        env.ledger().set_timestamp(1000);
        let _ = AcademyVestingContract::claim(env.clone(), grant_id, beneficiary.clone());
        // If any optimization breaks logic, this will fail
        let schedule = AcademyVestingContract::get_vesting(env, grant_id).unwrap();
        assert!(schedule.claimed);
    }
}
