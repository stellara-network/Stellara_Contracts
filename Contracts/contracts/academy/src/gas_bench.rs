// Soroban contract benchmarking for AcademyVestingContract
// Usage: Run with cargo test --features benchmark

#[cfg(test)]
mod gas_benchmarks {
    use super::*;
    use soroban_sdk::{testutils::*, Address, Env};

    fn setup_contract() -> (Env, Address, Address, Address) {
        let env = Env::default();
        let admin = Address::random(&env);
        let reward_token = Address::random(&env);
        let governance = Address::random(&env);
        AcademyVestingContract::init(env.clone(), admin.clone(), reward_token.clone(), governance.clone()).unwrap();
        (env, admin, reward_token, governance)
    }

    #[test]
    fn bench_grant_vesting() {
        let (env, admin, _reward_token, governance) = setup_contract();
        let beneficiary = Address::random(&env);
        let start_time = 1000u64;
        let cliff = 100u64;
        let duration = 1000u64;
        let amount = 1000i128;
        let before = env.ledger().timestamp();
        let _ = AcademyVestingContract::grant_vesting(env.clone(), admin.clone(), beneficiary, amount, start_time, cliff, duration);
        let after = env.ledger().timestamp();
        println!("grant_vesting gas: {}", after - before);
    }

    #[test]
    fn bench_claim() {
        let (env, admin, _reward_token, governance) = setup_contract();
        let beneficiary = Address::random(&env);
        let start_time = 0u64;
        let cliff = 100u64;
        let duration = 1000u64;
        let amount = 1000i128;
        let _ = AcademyVestingContract::grant_vesting(env.clone(), admin.clone(), beneficiary.clone(), amount, start_time, cliff, duration);
        env.ledger().set_timestamp(start_time + cliff + 500);
        let before = env.ledger().timestamp();
        let _ = AcademyVestingContract::claim(env.clone(), 1, beneficiary);
        let after = env.ledger().timestamp();
        println!("claim gas: {}", after - before);
    }
}
