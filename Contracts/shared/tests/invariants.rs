#![cfg(test)]

use proptest::prelude::*;
use soroban_sdk::{Env, Address};

use stellara_contracts::token::{TokenContract, TokenContractClient};

#[derive(Clone, Debug)]
enum Action {
    Transfer(u128),
    Mint(u128),
}

proptest! {

    /// -----------------------------------------
    /// Stateful invariant: supply + balances safe
    /// -----------------------------------------
    #[test]
    fn state_machine_invariants(
        initial_supply in 1_000u128..1_000_000u128,
        actions in prop::collection::vec(
            prop_oneof![
                (1u128..10_000u128).prop_map(Action::Transfer),
                (1u128..10_000u128).prop_map(Action::Mint),
            ],
            1..50
        )
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let owner = Address::generate(&env);
        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);

        let contract_id = env.register_contract(None, TokenContract);
        let token = TokenContractClient::new(&env, &contract_id);

        token.initialize(&owner, &initial_supply);
        token.mint(&owner, &user1, &initial_supply);

        let mut expected_supply = initial_supply;

        for action in actions {
            match action {
                Action::Transfer(amount) => {
                    let balance = token.balance(&user1);
                    let amt = amount.min(balance);
                    if amt > 0 {
                        token.transfer(&user1, &user2, &amt);
                    }
                }
                Action::Mint(amount) => {
                    token.mint(&owner, &user1, &amount);
                    expected_supply += amount;
                }
            }

            // 🔒 invariants after every step
            let total_supply = token.total_supply();
            let b1 = token.balance(&user1);
            let b2 = token.balance(&user2);

            prop_assert_eq!(b1 + b2, total_supply);
            prop_assert!(b1 >= 0);
            prop_assert!(b2 >= 0);
            prop_assert_eq!(total_supply, expected_supply);
        }
    }

    /// -------------------------------
    /// Invariant: totalSupply conserved on transfer
    /// -------------------------------
    #[test]
    fn total_supply_invariant(
        initial_supply in 1_000u128..1_000_000u128,
        transfer_amount in 1u128..10_000u128,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);

        let contract_id = env.register_contract(None, TokenContract);
        let token = TokenContractClient::new(&env, &contract_id);

        token.initialize(&admin, &initial_supply);
        token.mint(&admin, &user1, &initial_supply);

        let supply_before = token.total_supply();

        let amount = transfer_amount.min(initial_supply);
        token.transfer(&user1, &user2, &amount);

        let supply_after = token.total_supply();
        prop_assert_eq!(supply_before, supply_after);
    }

    /// -------------------------------------
    /// Invariant: balances are never negative
    /// -------------------------------------
    #[test]
    fn balances_non_negative(
        supply in 1_000u128..1_000_000u128,
        transfer_amount in 1u128..500_000u128,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);

        let contract_id = env.register_contract(None, TokenContract);
        let token = TokenContractClient::new(&env, &contract_id);

        token.initialize(&admin, &supply);
        token.mint(&admin, &user1, &supply);

        let amount = transfer_amount.min(supply);
        token.transfer(&user1, &user2, &amount);

        prop_assert!(token.balance(&user1) >= 0);
        prop_assert!(token.balance(&user2) >= 0);
    }

    /// --------------------------------
    /// Invariant: only owner can mint
    /// --------------------------------
    #[test]
    fn ownership_invariant(
        supply in 1_000u128..1_000_000u128,
        mint_amount in 1u128..100_000u128,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let owner = Address::generate(&env);
        let attacker = Address::generate(&env);
        let user = Address::generate(&env);

        let contract_id = env.register_contract(None, TokenContract);
        let token = TokenContractClient::new(&env, &contract_id);

        token.initialize(&owner, &supply);

        let result = std::panic::catch_unwind(|| {
            token.mint(&attacker, &user, &mint_amount);
        });

        prop_assert!(result.is_err());
    }
}
