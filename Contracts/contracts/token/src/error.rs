use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum TokenError {
    Unauthorized = 1,
    AlreadyInitialized = 2,
    NotAuthorized = 3,
    InsufficientBalance = 4,
    InsufficientAllowance = 5,
    InvalidAmount = 6,
    ExpirationInPast = 7,
    ArithmeticOverflow = 8,
}
