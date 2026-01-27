# Stellara Token Contract

This contract implements the Soroban token interface (transfer, approve/allowance, burn) plus
administrator controls (mint, clawback, authorize) and metadata helpers.

## Standard Interface

The contract conforms to the `soroban_sdk::token::TokenInterface` and `StellarAssetInterface`:

- `allowance(from, spender) -> i128`
- `approve(from, spender, amount, expiration_ledger)`
- `balance(id) -> i128`
- `transfer(from, to, amount)`
- `transfer_from(spender, from, to, amount)`
- `burn(from, amount)`
- `burn_from(spender, from, amount)`
- `name() -> String`
- `symbol() -> String`
- `decimals() -> u32`

Admin methods:

- `set_admin(new_admin)`
- `admin() -> Address`
- `set_authorized(id, authorize)`
- `authorized(id) -> bool`
- `mint(to, amount)`
- `clawback(from, amount)`

Additional metadata helper:

- `metadata() -> TokenMetadata`

## SEP-0041 (Token Interface) Notes

This implementation targets the Soroban SDK `20.5.0` interface (Address-based transfers).
SEP-0041 v0.4.0 introduces `MuxedAddress` support for `transfer` and related events. That
upgrade is **not** enabled here to avoid a workspace-wide SDK bump. The contract still
emits standard `approve`, `transfer`, and `burn` events with Address topics and `i128`
amount data.

## Transfer Hook

When a transfer succeeds, the token attempts to notify the receiver contract using an optional
hook:

```
fn on_token_transfer(env: Env, from: Address, amount: i128, token: Address)
```

- The hook is invoked **after** balances are updated.
- If the receiver does not implement the hook or the hook fails, the transfer **still succeeds**.
- This provides safe fallback behavior for recipients that do not rely on hooks.

Contracts that want notifications can implement `on_token_transfer` and read the supplied sender,
amount, and token contract address.
