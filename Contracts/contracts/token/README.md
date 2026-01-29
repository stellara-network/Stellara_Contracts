# Token Contract

This contract implements the Soroban token standard interface (transfer, approve, allowance, burn, metadata) plus admin controls (mint, clawback, authorization). It is designed to be compatible with wallets and marketplaces that expect the standard `TokenInterface` functions.

## Initialization

```bash
# Called once
initialize(admin, name, symbol, decimals)
```

## Standard Methods

- `transfer(from, to, amount)`
- `transfer_from(spender, from, to, amount)`
- `approve(from, spender, amount, expiration_ledger)`
- `allowance(from, spender)`
- `balance(id)`
- `name()` / `symbol()` / `decimals()`
- `burn(from, amount)` / `burn_from(spender, from, amount)`

## Admin Methods

- `set_admin(new_admin)` / `admin()`
- `set_authorized(id, authorize)` / `authorized(id)`
- `mint(to, amount)`
- `clawback(from, amount)`

## Transfer Hooks

Transfers and transfer-from operations attempt a safe hook call on the recipient contract:

```
on_token_transfer(token: Address, from: Address, amount: i128) -> ()
```

If the recipient is not a contract, or if the method is missing or fails, the transfer still succeeds. This provides a safe fallback while enabling contracts to react to incoming tokens (e.g., escrow or marketplace accounting).

## Conformance Tests

Standard conformance checks live in `tests/conformance.rs` and validate transfer, approve/allowance, metadata, and allowance expiration behavior.
