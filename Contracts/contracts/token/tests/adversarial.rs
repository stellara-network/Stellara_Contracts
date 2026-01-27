use soroban_sdk::{
    contract, contractimpl, contracttype, testutils::Address as _, Address, Env, String,
};

use token::{TokenContract, TokenContractClient};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferRecord {
    pub from: Address,
    pub amount: i128,
    pub token: Address,
}

#[contracttype]
pub enum HookKey {
    Last,
}

mod receiver {
    use super::*;

    #[contract]
    pub struct ReceiverContract;

    #[contractimpl]
    impl ReceiverContract {
        pub fn on_token_transfer(env: Env, from: Address, amount: i128, token: Address) {
            let record = TransferRecord { from, amount, token };
            env.storage().instance().set(&HookKey::Last, &record);
        }

        pub fn last_transfer(env: Env) -> Option<TransferRecord> {
            env.storage().instance().get(&HookKey::Last)
        }
    }
}

mod no_hook_receiver {
    use super::*;

    #[contract]
    pub struct NoHookReceiverContract;

    #[contractimpl]
    impl NoHookReceiverContract {
        pub fn ping(_env: Env) {}
    }
}

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
fn transfer_hook_records_receiver_state() {
    let env = Env::default();
    let (_admin, token_id, client) = setup_token(&env);

    let sender = Address::generate(&env);
    client.mint(&sender, &500i128);

    let receiver_id = env.register_contract(None, receiver::ReceiverContract);
    let receiver = receiver::ReceiverContractClient::new(&env, &receiver_id);

    client.transfer(&sender, &receiver_id, &125i128);

    let record = receiver.last_transfer().unwrap();
    assert_eq!(record.from, sender);
    assert_eq!(record.amount, 125);
    assert_eq!(record.token, token_id);
    assert_eq!(client.balance(&receiver_id), 125);
}

#[test]
fn transfer_hook_failure_does_not_revert() {
    let env = Env::default();
    let (_admin, _token_id, client) = setup_token(&env);

    let sender = Address::generate(&env);
    client.mint(&sender, &200i128);

    let rejecting_id = env.register_contract(None, no_hook_receiver::NoHookReceiverContract);

    client.transfer(&sender, &rejecting_id, &75i128);

    assert_eq!(client.balance(&sender), 125);
    assert_eq!(client.balance(&rejecting_id), 75);
}
