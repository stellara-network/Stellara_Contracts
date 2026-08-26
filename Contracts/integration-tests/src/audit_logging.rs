#![cfg(test)]

//! Integration tests verifying that admin/governance state mutations emit
//! the standardized `AuditActionEvent` (topic `AUDIT_ACTION`) and that
//! denied admin attempts emit `AccessDeniedEvent` (topic `ACCESS_DENIED`),
//! per shared::events.
//!
//! NOTE: only the academy vesting contract is covered here. I have the
//! full source for academy/src/vesting.rs and could verify the exact
//! function signatures and event flow against it. I have not seen the
//! trading or messaging contracts' actual client/import paths in this
//! workspace, so equivalent tests for those are left as a TODO rather
//! than guessed at — copy the pattern below once the import paths are
//! confirmed.

use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    Address, Env, Symbol, TryIntoVal,
};

use academy::{AcademyVestingContract, AcademyVestingContractClient};
use shared::circuit_breaker::CircuitBreakerConfig;
use shared::events::topics;

fn setup_vesting_env() -> (Env, AcademyVestingContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, AcademyVestingContract);
    let client = AcademyVestingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governance = Address::generate(&env);
    let reward_token = Address::generate(&env);

    client.init(
        &admin,
        &reward_token,
        &governance,
        &CircuitBreakerConfig::default(),
    );

    (env, client, admin)
}

/// Returns true if any emitted event on this contract used the given topic symbol.
fn has_event_with_topic(env: &Env, topic: Symbol) -> bool {
    env.events().all().iter().any(|(_, topics_val, _)| {
        // Topics are published as a tuple; the audit/access-denied events in
        // shared::events publish a single-element tuple, e.g. (topics::AUDIT_ACTION,).
        topics_val
            .clone()
            .try_into_val(env)
            .map(|t: soroban_sdk::Vec<Symbol>| t.iter().any(|s| s == topic))
            .unwrap_or(false)
    })
}

#[test]
fn grant_vesting_emits_audit_action_event() {
    let (env, client, admin) = setup_vesting_env();
    let beneficiary = Address::generate(&env);

    client.grant_vesting(&admin, &beneficiary, &1_000i128, &0u64, &0u64, &1_000u64);

    assert!(
        has_event_with_topic(&env, topics::AUDIT_ACTION),
        "expected an AUDIT_ACTION event after grant_vesting"
    );
}

#[test]
fn grant_vesting_by_non_admin_emits_access_denied_event() {
    let (env, client, _admin) = setup_vesting_env();
    let not_admin = Address::generate(&env);
    let beneficiary = Address::generate(&env);

    let result =
        client.try_grant_vesting(&not_admin, &beneficiary, &1_000i128, &0u64, &0u64, &1_000u64);

    assert!(result.is_err(), "non-admin grant_vesting call should fail");
    assert!(
        has_event_with_topic(&env, topics::ACCESS_DENIED),
        "expected an ACCESS_DENIED event when a non-admin calls grant_vesting"
    );
}

#[test]
fn revoke_emits_audit_action_event() {
    let (env, client, admin) = setup_vesting_env();
    let beneficiary = Address::generate(&env);

    let grant_id =
        client.grant_vesting(&admin, &beneficiary, &1_000i128, &0u64, &0u64, &1_000u64);

    // revoke() requires revoke_delay >= 3600s AND current_time >= start_time + revoke_delay
    env.ledger().with_mut(|l| {
        l.timestamp += 7_200;
    });

    client.revoke(&grant_id, &admin, &3_600u64);

    assert!(
        has_event_with_topic(&env, topics::AUDIT_ACTION),
        "expected an AUDIT_ACTION event after revoke"
    );
}

#[test]
fn revoke_by_non_admin_emits_access_denied_event() {
    let (env, client, admin) = setup_vesting_env();
    let not_admin = Address::generate(&env);
    let beneficiary = Address::generate(&env);

    let grant_id =
        client.grant_vesting(&admin, &beneficiary, &1_000i128, &0u64, &0u64, &1_000u64);

    env.ledger().with_mut(|l| {
        l.timestamp += 7_200;
    });

    let result = client.try_revoke(&grant_id, &not_admin, &3_600u64);

    assert!(result.is_err(), "non-admin revoke call should fail");
    assert!(
        has_event_with_topic(&env, topics::ACCESS_DENIED),
        "expected an ACCESS_DENIED event when a non-admin calls revoke"
    );
}

// TODO: mirror these four tests for:
//   - trading contract: every ACL-protected admin fn + governance fn
//   - messaging contract: set_rate_limit_config, set_premium_user,
//     set_cb_pause_level, pause/unpause_cb_function, create_role,
//     assign_role, assign_permission, assign_permissions_batch,
//     set_role_parent, and the five governance functions
// once this file's import paths are confirmed against the actual
// integration-tests crate setup (contract registration helpers,
// client naming, existing fixtures if any already exist for those
// contracts).