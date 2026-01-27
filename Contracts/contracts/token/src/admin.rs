use soroban_sdk::Env;

use crate::storage::admin;

pub fn require_admin(env: &Env) {
    let current_admin = admin(env);
    current_admin.require_auth();
}
