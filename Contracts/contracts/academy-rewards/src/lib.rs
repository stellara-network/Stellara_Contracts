#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, contracterror, Address, Env, String, Symbol};

// Contract Errors
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    ContractPaused = 4,
    InvalidDiscount = 5,
    BadgeTypeNotFound = 6,
    BadgeTypeDisabled = 7,
    UserAlreadyHasBadge = 8,
    UserHasNoBadge = 9,
    BadgeNotActive = 10,
    BadgeExpired = 11,
    RedemptionLimitReached = 12,
    TransactionAlreadyRedeemed = 13,
}

// Storage keys
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Badge(Address),                  // Badge info per user
    BadgeMetadata(u32),              // Badge type metadata
    RedemptionHistory(Address, u32), // Track redemptions
    TotalBadgesMinted(u32),          // Counter per badge type
    PausedState,
    UsedTransactionHash(String),     // Track used transaction hashes globally
}

// Badge struct
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Badge {
    pub badge_type: u32,      // Type of badge (1=Bronze, 2=Silver, 3=Gold, etc.)
    pub discount_bps: u32,    // Discount in basis points (100 = 1%)
    pub earned_at: u64,       // Timestamp when earned
    pub redeemed_count: u32,  // Number of times redeemed
    pub max_redemptions: u32, // Max allowed redemptions (0 = unlimited)
    pub expiry: u64,          // Expiry timestamp (0 = never expires)
    pub active: bool,         // Whether badge is active
}

// Badge type metadata
#[contracttype]
#[derive(Clone, Debug)]
pub struct BadgeMetadata {
    pub name: String,
    pub discount_bps: u32,
    pub max_redemptions: u32,
    pub validity_duration: u64, // Duration in seconds
    pub enabled: bool,
}

// Redemption record for audit trail
#[contracttype]
#[derive(Clone, Debug)]
pub struct RedemptionRecord {
    pub badge_type: u32,
    pub timestamp: u64,
    pub discount_applied: u32,
    pub transaction_hash: String,
}

#[contract]
pub struct AcademyRewardsContract;

#[contractimpl]
impl AcademyRewardsContract {
    // ========== INITIALIZATION ==========

    /// Initialize the contract with admin
    pub fn initialize(env: Env, admin: Address) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ContractError::AlreadyInitialized);
        }

        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::PausedState, &false);
        
        Ok(())
    }

    // ========== ADMIN FUNCTIONS ==========

    /// Create a new badge type
    pub fn create_badge_type(
        env: Env,
        admin: Address,
        badge_type: u32,
        name: String,
        discount_bps: u32,
        max_redemptions: u32,
        validity_duration: u64,
    ) -> Result<(), ContractError> {
        Self::require_admin(&env, &admin)?;

        // Validate discount (max 100% = 10000 bps)
        if discount_bps > 10000 {
            return Err(ContractError::InvalidDiscount);
        }

        let metadata = BadgeMetadata {
            name,
            discount_bps,
            max_redemptions,
            validity_duration,
            enabled: true,
        };

        env.storage()
            .persistent()
            .set(&DataKey::BadgeMetadata(badge_type), &metadata);

        // Initialize counter
        env.storage()
            .persistent()
            .set(&DataKey::TotalBadgesMinted(badge_type), &0u32);
            
        Ok(())
    }

    /// Mint/award a badge to a user
    pub fn mint_badge(
        env: Env,
        admin: Address,
        recipient: Address,
        badge_type: u32,
    ) -> Result<(), ContractError> {
        Self::require_admin(&env, &admin)?;
        Self::require_not_paused(&env)?;

        // Check if badge type exists
        let metadata: BadgeMetadata = env
            .storage()
            .persistent()
            .get(&DataKey::BadgeMetadata(badge_type))
            .ok_or(ContractError::BadgeTypeNotFound)?;

        if !metadata.enabled {
            return Err(ContractError::BadgeTypeDisabled);
        }

        // Check if user already has this badge
        let badge_key = DataKey::Badge(recipient.clone());
        if env.storage().persistent().has(&badge_key) {
            let existing: Badge = env.storage().persistent().get(&badge_key).unwrap();
            if existing.badge_type == badge_type && existing.active {
                return Err(ContractError::UserAlreadyHasBadge);
            }
        }

        // Create badge
        let expiry = if metadata.validity_duration > 0 {
            env.ledger().timestamp() + metadata.validity_duration
        } else {
            0
        };

        let badge = Badge {
            badge_type,
            discount_bps: metadata.discount_bps,
            earned_at: env.ledger().timestamp(),
            redeemed_count: 0,
            max_redemptions: metadata.max_redemptions,
            expiry,
            active: true,
        };

        // Store badge
        env.storage().persistent().set(&badge_key, &badge);

        // Increment counter
        let mut count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalBadgesMinted(badge_type))
            .unwrap_or(0);
        count += 1;
        env.storage()
            .persistent()
            .set(&DataKey::TotalBadgesMinted(badge_type), &count);

        // Emit event
        env.events().publish(
            (Symbol::new(&env, "badge_minted"),),
            (recipient, badge_type, env.ledger().timestamp()),
        );
        
        Ok(())
    }

    /// Revoke a badge from a user
    pub fn revoke_badge(env: Env, admin: Address, user: Address) -> Result<(), ContractError> {
        Self::require_admin(&env, &admin)?;

        let badge_key = DataKey::Badge(user.clone());

        if let Some(mut badge) = env.storage().persistent().get::<DataKey, Badge>(&badge_key) {
            badge.active = false;
            env.storage().persistent().set(&badge_key, &badge);

            env.events().publish(
                (Symbol::new(&env, "badge_revoked"),),
                (user, badge.badge_type),
            );
            
            Ok(())
        } else {
            Err(ContractError::UserHasNoBadge)
        }
    }

    /// Pause/unpause contract
    pub fn set_paused(env: Env, admin: Address, paused: bool) -> Result<(), ContractError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::PausedState, &paused);
        Ok(())
    }

    // ========== USER FUNCTIONS ==========

    /// Redeem badge for fee discount
    /// Returns the discount amount in basis points
    pub fn redeem_badge(
        env: Env,
        user: Address,
        transaction_hash: String,
    ) -> Result<u32, ContractError> {
        user.require_auth();
        Self::require_not_paused(&env)?;

        // Check if transaction hash has been used before (globally)
        let tx_key = DataKey::UsedTransactionHash(transaction_hash.clone());
        if env.storage().persistent().has(&tx_key) {
            return Err(ContractError::TransactionAlreadyRedeemed);
        }

        let badge_key = DataKey::Badge(user.clone());

        let mut badge: Badge = env
            .storage()
            .persistent()
            .get(&badge_key)
            .ok_or(ContractError::UserHasNoBadge)?;

        // Validation checks
        if !badge.active {
            return Err(ContractError::BadgeNotActive);
        }

        // Check expiry
        if badge.expiry > 0 && env.ledger().timestamp() > badge.expiry {
            return Err(ContractError::BadgeExpired);
        }

        // Check redemption limit
        if badge.max_redemptions > 0 && badge.redeemed_count >= badge.max_redemptions {
            return Err(ContractError::RedemptionLimitReached);
        }

        // Record redemption
        let redemption_record = RedemptionRecord {
            badge_type: badge.badge_type,
            timestamp: env.ledger().timestamp(),
            discount_applied: badge.discount_bps,
            transaction_hash: transaction_hash.clone(),
        };

        // Store redemption at the current count index BEFORE incrementing
        let redemption_key = DataKey::RedemptionHistory(user.clone(), badge.redeemed_count);
        env.storage()
            .persistent()
            .set(&redemption_key, &redemption_record);

        // Mark transaction as used globally
        env.storage().persistent().set(&tx_key, &true);

        // Update badge (increment count)
        badge.redeemed_count += 1;
        env.storage().persistent().set(&badge_key, &badge);

        // Emit event
        env.events().publish(
            (Symbol::new(&env, "badge_redeemed"),),
            (user, badge.badge_type, badge.discount_bps),
        );

        Ok(badge.discount_bps)
    }

    /// Check if user has an active badge and get discount
    pub fn get_user_discount(env: Env, user: Address) -> u32 {
        let badge_key = DataKey::Badge(user);

        if let Some(badge) = env.storage().persistent().get::<DataKey, Badge>(&badge_key) {
            // Check if badge is valid
            if !badge.active {
                return 0;
            }

            if badge.expiry > 0 && env.ledger().timestamp() > badge.expiry {
                return 0;
            }

            if badge.max_redemptions > 0 && badge.redeemed_count >= badge.max_redemptions {
                return 0;
            }

            return badge.discount_bps;
        }

        0
    }

    /// Get user's badge information
    pub fn get_user_badge(env: Env, user: Address) -> Option<Badge> {
        env.storage().persistent().get(&DataKey::Badge(user))
    }

    /// Get badge metadata
    pub fn get_badge_metadata(env: Env, badge_type: u32) -> Option<BadgeMetadata> {
        env.storage()
            .persistent()
            .get(&DataKey::BadgeMetadata(badge_type))
    }

    /// Get total badges minted for a type
    pub fn get_total_minted(env: Env, badge_type: u32) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::TotalBadgesMinted(badge_type))
            .unwrap_or(0)
    }

    /// Get redemption history for user
    pub fn get_redemption_history(env: Env, user: Address, index: u32) -> Option<RedemptionRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::RedemptionHistory(user, index))
    }

    // ========== HELPER FUNCTIONS ==========

    fn require_admin(env: &Env, admin: &Address) -> Result<(), ContractError> {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ContractError::NotInitialized)?;

        if admin != &stored_admin {
            return Err(ContractError::Unauthorized);
        }
        
        Ok(())
    }

    fn require_not_paused(env: &Env) -> Result<(), ContractError> {
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::PausedState)
            .unwrap_or(false);

        if paused {
            return Err(ContractError::ContractPaused);
        }
        
        Ok(())
    }
}

mod test;