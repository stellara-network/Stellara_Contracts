#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    Address, Bytes, Env, Map, Symbol, Vec,
    contracterror,
};
use shared::governance::GovernanceManager;
use shared::events::{
    extended_topics, HubCreatedEvent, DataEntryAddedEvent,
    PermissionGrantedEvent, PermissionRevokedEvent, SelectiveDisclosureCreatedEvent,
};

// ─────────────────────────────────────────────────────────────────────────────
// Storage keys
// ─────────────────────────────────────────────────────────────────────────────

mod keys {
    use soroban_sdk::{symbol_short, Symbol};
    pub const HUBS:      Symbol = symbol_short!("hubs");
    pub const OWN_HUB:   Symbol = symbol_short!("own_hub");
    pub const HUB_CNT:   Symbol = symbol_short!("hub_cnt");
    pub const DISC_CNT:  Symbol = symbol_short!("disc_cnt");
    pub const DISCLOSRS: Symbol = symbol_short!("disclosrs");
}

// ─────────────────────────────────────────────────────────────────────────────
// Data structures
// ─────────────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdentityHub {
    pub id: Symbol,
    pub owner_did: Symbol,
    pub data_entries: Vec<DataEntry>,
    pub permissions: Vec<Permission>,
    pub kyc_level: KycLevel,
    pub kyc_verified_at: Option<u64>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DataEntry {
    pub id: Symbol,
    pub type_: Symbol,
    pub encrypted_data: Bytes,
    pub hash: Bytes,
    pub created_at: u64,
    pub expires_at: Option<u64>,
    pub metadata: Map<Symbol, Symbol>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Permission {
    pub id: Symbol,
    pub granter_did: Symbol,
    pub grantee_did: Symbol,
    pub data_entry_id: Symbol,
    pub permission_type: PermissionType,
    pub conditions: Vec<Condition>,
    pub created_at: u64,
    pub expires_at: Option<u64>,
    pub active: bool,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PermissionType {
    Read   = 0,
    Write  = 1,
    Share  = 2,
    Verify = 3,
}

/// KYC verification levels
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum KycLevel {
    None = 0,
    Basic = 1,
    Enhanced = 2,
    Institutional = 3,
}

/// Condition value stored as a u64 (timestamp limit or numeric threshold).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Condition {
    pub type_: Symbol,
    pub value: u64,
    pub operator: Symbol,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectiveDisclosure {
    pub id: Symbol,
    pub presenter_did: Symbol,
    pub verifier_did: Symbol,
    pub data_entry_id: Symbol,
    pub disclosed_fields: Vec<Symbol>,
    pub proof: Bytes,
    pub nonce: Bytes,
    pub created_at: u64,
    pub expires_at: u64,
}

// ─────────────────────────────────────────────────────────────────────────────
// Error codes
// ─────────────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum IdentityHubError {
    HubNotFound        = 5001,
    Unauthorized       = 5002,
    DataEntryNotFound  = 5003,
    PermissionDenied   = 5004,
    InvalidEncryption  = 5005,
    ExpiredData        = 5006,
    InvalidPermission  = 5007,
    GovernanceError    = 5008,
    /// Returned when `initialize()` is called more than once.
    AlreadyInitialized = 5009,
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

#[contract]
pub struct IdentityHubContract;

#[contractimpl]
impl IdentityHubContract {
    // ── Initialization ────────────────────────────────────────────────────

    /// Initialize the contract with ACL-backed governance roles.
    ///
    /// Protected by the upgradeability module — a second call returns
    /// `AlreadyInitialized` without touching any state.
    pub fn initialize(
        env: Env,
        admin: Address,
        approvers: Vec<Address>,
        executor: Address,
    ) -> Result<(), IdentityHubError> {
        if upgradeability::is_initialized(&env) {
            return Err(IdentityHubError::AlreadyInitialized);
        }
        upgradeability::mark_initialized(&env);

        GovernanceManager::init_governance_roles(&env, admin, approvers, executor);
        env.storage().persistent().set(&keys::HUB_CNT, &0u64);

        Ok(())
    }

    // ── Hub management ────────────────────────────────────────────────────

    pub fn create_hub(env: Env, caller: Address, owner_did: Symbol) -> Symbol {
        caller.require_auth();

        if Self::find_hub_id(&env, &owner_did).is_some() {
            panic!("Hub already exists for this DID");
        }

        let count: u64 = env.storage().persistent().get(&keys::HUB_CNT).unwrap_or(0);
        let hub_id = Self::count_symbol(&env, count, "h");

        let mut hubs: Map<Symbol, IdentityHub> = env.storage().persistent()
            .get(&keys::HUBS).unwrap_or_else(|| Map::new(&env));
        hubs.set(hub_id.clone(), IdentityHub {
            id: hub_id.clone(),
            owner_did: owner_did.clone(),
            data_entries: Vec::new(&env),
            permissions: Vec::new(&env),
            kyc_level: KycLevel::None,
            kyc_verified_at: None,
            created_at: env.ledger().timestamp(),
            updated_at: env.ledger().timestamp(),
        });
        env.storage().persistent().set(&keys::HUBS, &hubs);

        let mut owner_map: Map<Symbol, Symbol> = env.storage().persistent()
            .get(&keys::OWN_HUB).unwrap_or_else(|| Map::new(&env));
        owner_map.set(owner_did.clone(), hub_id.clone());
        env.storage().persistent().set(&keys::OWN_HUB, &owner_map);
        env.storage().persistent().set(&keys::HUB_CNT, &(count + 1));

        env.events().publish(
            (extended_topics::HUB_CREATED,),
            HubCreatedEvent { hub_id: hub_id.clone(), owner_did, timestamp: env.ledger().timestamp() },
        );
        hub_id
    }

    pub fn add_data_entry(
        env: Env,
        caller: Address,
        hub_id: Symbol,
        data_type: Symbol,
        encrypted_data: Bytes,
        hash: Bytes,
        expires_at: Option<u64>,
        metadata: Map<Symbol, Symbol>,
    ) -> Symbol {
        caller.require_auth();
        let mut hub = Self::load_hub(&env, &hub_id).unwrap_or_else(|| panic!("Hub not found"));

        let entry_id = Self::count_symbol(&env, hub.data_entries.len() as u64, "d");
        hub.data_entries.push_back(DataEntry {
            id: entry_id.clone(),
            type_: data_type,
            encrypted_data,
            hash,
            created_at: env.ledger().timestamp(),
            expires_at,
            metadata,
        });
        hub.updated_at = env.ledger().timestamp();
        Self::save_hub(&env, &hub_id, hub);

        env.events().publish(
            (extended_topics::DATA_ENTRY_ADDED,),
            DataEntryAddedEvent { hub_id, entry_id: entry_id.clone(), added_by: caller, timestamp: env.ledger().timestamp() },
        );
        entry_id
    }

    pub fn grant_permission(
        env: Env,
        caller: Address,
        hub_id: Symbol,
        grantee_did: Symbol,
        data_entry_id: Symbol,
        permission_type: PermissionType,
        conditions: Vec<Condition>,
        expires_at: Option<u64>,
    ) -> Symbol {
        caller.require_auth();
        let mut hub = Self::load_hub(&env, &hub_id).unwrap_or_else(|| panic!("Hub not found"));

        if !hub.data_entries.iter().any(|e| e.id == data_entry_id) {
            panic!("Data entry not found");
        }

        let perm_id = Self::count_symbol(&env, hub.permissions.len() as u64, "p");
        hub.permissions.push_back(Permission {
            id: perm_id.clone(),
            granter_did: hub.owner_did.clone(),
            grantee_did,
            data_entry_id,
            permission_type,
            conditions,
            created_at: env.ledger().timestamp(),
            expires_at,
            active: true,
        });
        hub.updated_at = env.ledger().timestamp();
        Self::save_hub(&env, &hub_id, hub);

        env.events().publish(
            (extended_topics::PERM_GRANTED,),
            PermissionGrantedEvent { hub_id, permission_id: perm_id.clone(), grantee: caller.clone(), grantor: caller, timestamp: env.ledger().timestamp() },
        );
        perm_id
    }

    pub fn revoke_permission(env: Env, caller: Address, hub_id: Symbol, permission_id: Symbol) {
        caller.require_auth();
        let mut hub = Self::load_hub(&env, &hub_id).unwrap_or_else(|| panic!("Hub not found"));

        let mut updated = Vec::new(&env);
        for mut perm in hub.permissions.iter() {
            if perm.id == permission_id { perm.active = false; }
            updated.push_back(perm);
        }
        hub.permissions = updated;
        hub.updated_at = env.ledger().timestamp();
        Self::save_hub(&env, &hub_id, hub);

        env.events().publish(
            (extended_topics::PERM_REVOKED,),
            PermissionRevokedEvent { hub_id, permission_id, revoked_by: caller, timestamp: env.ledger().timestamp() },
        );
    }

    pub fn create_selective_disclosure(
        env: Env,
        caller: Address,
        presenter_did: Symbol,
        verifier_did: Symbol,
        data_entry_id: Symbol,
        disclosed_fields: Vec<Symbol>,
        proof: Bytes,
        nonce: Bytes,
        expires_at: u64,
    ) -> Symbol {
        caller.require_auth();

        let hub_id = Self::get_hub_by_owner(env.clone(), presenter_did.clone());
        let hub = Self::load_hub(&env, &hub_id).unwrap_or_else(|| panic!("Hub not found"));

        if !hub.data_entries.iter().any(|e| e.id == data_entry_id) {
            panic!("Data entry not found in presenter hub");
        }

        let count: u64 = env.storage().persistent().get(&keys::DISC_CNT).unwrap_or(0);
        let disc_id = Self::count_symbol(&env, count, "dc");

        let mut disclosures: Map<Symbol, SelectiveDisclosure> = env.storage().persistent()
            .get(&keys::DISCLOSRS).unwrap_or_else(|| Map::new(&env));
        disclosures.set(disc_id.clone(), SelectiveDisclosure {
            id: disc_id.clone(),
            presenter_did,
            verifier_did,
            data_entry_id,
            disclosed_fields,
            proof,
            nonce,
            created_at: env.ledger().timestamp(),
            expires_at,
        });
        env.storage().persistent().set(&keys::DISCLOSRS, &disclosures);
        env.storage().persistent().set(&keys::DISC_CNT, &(count + 1));

        env.events().publish(
            (extended_topics::DISCLOSURE_CREATED,),
            SelectiveDisclosureCreatedEvent { disclosure_id: disc_id.clone(), hub_id: hub.id, requester: caller, timestamp: env.ledger().timestamp() },
        );
        disc_id
    }

    pub fn verify_selective_disclosure(env: Env, disclosure_id: Symbol) -> bool {
        let disclosures: Map<Symbol, SelectiveDisclosure> = env.storage().persistent()
            .get(&keys::DISCLOSRS).unwrap_or_else(|| Map::new(&env));
        match disclosures.get(disclosure_id) {
            Some(d) => env.ledger().timestamp() <= d.expires_at && !d.proof.is_empty(),
            None => false,
        }
    }

    pub fn get_data_entry(env: Env, hub_id: Symbol, data_entry_id: Symbol, requester_did: Symbol) -> DataEntry {
        let hub = Self::load_hub(&env, &hub_id).unwrap_or_else(|| panic!("Hub not found"));
        let entry = hub.data_entries.iter()
            .find(|e| e.id == data_entry_id)
            .unwrap_or_else(|| panic!("Data entry not found"));

        if let Some(exp) = entry.expires_at {
            if env.ledger().timestamp() > exp { panic!("Data entry has expired"); }
        }
        if hub.owner_did != requester_did {
            let ok = hub.permissions.iter().any(|p| {
                p.active && p.grantee_did == requester_did && p.data_entry_id == data_entry_id
                    && matches!(p.permission_type, PermissionType::Read)
                    && Self::check_conditions(&env, &p.conditions)
            });
            if !ok { panic!("Permission denied"); }
        }
        entry
    }

    pub fn get_hub_details(env: Env, hub_id: Symbol) -> IdentityHub {
        Self::load_hub(&env, &hub_id).unwrap_or_else(|| panic!("Hub not found"))
    }

    pub fn get_hub_by_owner(env: Env, owner_did: Symbol) -> Symbol {
        Self::find_hub_id(&env, &owner_did).unwrap_or_else(|| panic!("Hub not found for owner"))
    }

    pub fn get_hub_count(env: Env) -> u64 {
        env.storage().persistent().get(&keys::HUB_CNT).unwrap_or(0)
    }

    /// Update KYC level for a hub (admin only)
    pub fn update_kyc_level(env: Env, caller: Address, hub_id: Symbol, kyc_level: KycLevel) -> Result<(), IdentityHubError> {
        caller.require_auth();
        let mut hub = Self::load_hub(&env, &hub_id).unwrap_or_else(|| panic!("Hub not found"));

        hub.kyc_level = kyc_level;
        hub.kyc_verified_at = Some(env.ledger().timestamp());
        hub.updated_at = env.ledger().timestamp();
        Self::save_hub(&env, &hub_id, hub);

        Ok(())
    }

    /// Get KYC level for a hub
    pub fn get_kyc_level(env: Env, hub_id: Symbol) -> KycLevel {
        let hub = Self::load_hub(&env, &hub_id).unwrap_or_else(|| panic!("Hub not found"));
        hub.kyc_level
    }

    /// Get account age in days
    pub fn get_account_age_days(env: Env, hub_id: Symbol) -> u64 {
        let hub = Self::load_hub(&env, &hub_id).unwrap_or_else(|| panic!("Hub not found"));
        let now = env.ledger().timestamp();
        (now - hub.created_at) / 86400
    }

    // ── Internal helpers ──────────────────────────────────────────────────

    fn find_hub_id(env: &Env, owner_did: &Symbol) -> Option<Symbol> {
        let m: Map<Symbol, Symbol> = env.storage().persistent()
            .get(&keys::OWN_HUB).unwrap_or_else(|| Map::new(env));
        m.get(owner_did.clone())
    }

    fn load_hub(env: &Env, hub_id: &Symbol) -> Option<IdentityHub> {
        let hubs: Map<Symbol, IdentityHub> = env.storage().persistent()
            .get(&keys::HUBS).unwrap_or_else(|| Map::new(env));
        hubs.get(hub_id.clone())
    }

    fn save_hub(env: &Env, hub_id: &Symbol, hub: IdentityHub) {
        let mut hubs: Map<Symbol, IdentityHub> = env.storage().persistent()
            .get(&keys::HUBS).unwrap_or_else(|| Map::new(env));
        hubs.set(hub_id.clone(), hub);
        env.storage().persistent().set(&keys::HUBS, &hubs);
    }

    fn check_conditions(env: &Env, conditions: &Vec<Condition>) -> bool {
        let time_key = symbol_short!("time_lmt");
        for c in conditions.iter() {
            if c.type_ == time_key && env.ledger().timestamp() > c.value { return false; }
        }
        true
    }

    fn count_symbol(env: &Env, count: u64, prefix: &str) -> Symbol {
        let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
        let mut buf = [b'0'; 9];
        let pb = prefix.as_bytes();
        let plen = pb.len().min(2);
        buf[..plen].copy_from_slice(&pb[..plen]);
        let mut n = count;
        let mut pos = 8usize;
        loop {
            buf[pos] = digits[(n % 36) as usize];
            n /= 36;
            if n == 0 || pos == plen { break; }
            pos -= 1;
        }
        let start = buf[plen..].iter().position(|&b| b != b'0')
            .map(|p| p + plen).unwrap_or(plen);
        Symbol::new(env, core::str::from_utf8(&buf[start..]).unwrap_or("x0"))
    }
}
