Multisig Treasury
=================

Overview
--------

`MultisigTreasury.sol` provides a hardened multi-signature treasury with:

- **M-of-N approval tiers** — ordinary transfers, large transfers, sensitive
  parameter changes, and emergency operations each have their own confirmation
  threshold.
- **Timelocks (1–7 days)** — risky operations (large transfers and sensitive
  parameter changes) cannot execute until their timelock elapses.
- **Atomic batch execution** — an array of approved proposals executes as one
  all-or-nothing unit, with a correlation id on every emitted event.
- **Emergency pause** — halts new activity while deliberately keeping the
  emergency-withdrawal escape hatch open.
- **Emergency operations** — freeze/unfreeze bypass the timelock but require
  **unanimous** approval from every owner.
- **Configurable daily/weekly spending limits** with rolling windows.
- **Reentrancy protection** and **pre/post-execution state-consistency
  validation**.
- **Audit events** for every state change.
- **Upgrade-safe storage layout** (reserved `__gap` slots).

Approval tiers
--------------

| Operation                          | Confirmations required            | Timelock |
| :--------------------------------- | :-------------------------------- | :------- |
| Transfer ≤ threshold               | 1                                 | No       |
| Transfer > threshold               | `required` (base M-of-N)          | Yes      |
| Sensitive parameter change         | `sensitiveRequired` (≥ required)  | Yes      |
| `pause`                            | `required` (base M-of-N)          | No       |
| `unpause`                          | `sensitiveRequired` (≥ required)  | No       |
| Emergency withdrawal (while paused)| All owners (unanimous)            | No       |
| Emergency freeze / unfreeze        | All owners (unanimous)            | No       |

Sensitive operations are the self-call functions `updateLimits`,
`updateTimelock`, `updateSensitiveRequired`, and `unpause`. They need the higher
`sensitiveRequired` threshold. All of them except `unpause` are also timelocked
— unpausing restores normal operation during an incident and must not be
delayed. Raising or lowering governance parameters always requires the
**currently configured** `sensitiveRequired`.

The asymmetry between `pause` and `unpause` is deliberate: pausing only ever
*removes* capability, so it clears the base threshold and executes immediately;
restoring capability is the dangerous direction and carries the higher bar.

Batch execution
---------------

Proposals are submitted and confirmed individually, then executed together.
`executeBatch` runs its members inside a single EVM transaction, so a revert
anywhere — a missing confirmation, an unelapsed timelock, a breached spending
window, or a failing external call — rolls back **every** member: none is
marked executed and no funds move.

Each member is subject to the exact same approval tier, timelock, pause/freeze
gate and spending-limit checks it would face on its own; batching grants no
extra authority. Spending windows accumulate across the batch, so members that
individually fit the daily limit but collectively breach it fail as a unit.

`MAX_BATCH_SIZE` (20) bounds both `submitBatch` and `executeBatch`. Without a
cap, an atomic batch could be made large enough to exceed the block gas limit
and become permanently unexecutable. A full 20-transfer batch costs ~1.15M gas.

Every batch carries a `batchId` correlation id, derived from
`keccak256(address(this), block.chainid, msg.sender, batchNonce)`. The id is
repeated on each per-transaction event so an off-chain auditor can group the
members of a batch without replaying calldata:

| Event                       | Emitted                                  |
| :-------------------------- | :--------------------------------------- |
| `BatchSubmitted`            | once per `submitBatch`                   |
| `BatchTransactionSubmitted` | once per member of a submitted batch     |
| `BatchExecuted`             | once per `executeBatch`                  |
| `BatchTransactionExecuted`  | once per member of an executed batch     |

The ordinary `SubmitTransaction` / `ExecuteTransaction` events are still emitted
for every member, so existing per-transaction monitoring keeps working.

### Submitting and executing a batch

```javascript
const treasuryAddress = await treasury.getAddress();

// 1. Submit three correlated payouts in one call (owners only).
const submitReceipt = await (
  await treasury.connect(owner0).submitBatch(
    [payeeA, payeeB, payeeC],
    [ethers.parseEther("1"), ethers.parseEther("1"), ethers.parseEther("0.5")],
    ["0x", "0x", "0x"]
  )
).wait();

// The returned indexes are contiguous; read them from the events or from
// getTransactionCount() before/after the call.
const batchId = submitReceipt.logs
  .map((log) => treasury.interface.parseLog(log))
  .find((event) => event?.name === "BatchSubmitted").args.batchId;

// 2. Confirm each member on its own approval tier.
for (const txIndex of [0, 1, 2]) {
  await treasury.connect(owner0).confirmTransaction(txIndex);
  await treasury.connect(owner1).confirmTransaction(txIndex);
}

// 3. Wait out the timelock of any member above `threshold`, then execute
//    atomically. If any member reverts, none of them execute.
await treasury.connect(owner0).executeBatch([0, 1, 2]);
```

Batching governance changes works the same way — submit the self-calls, collect
`sensitiveRequired` confirmations on each, wait out the timelock, and execute
them as one unit so the treasury never sits in a half-applied configuration:

```javascript
await treasury.connect(owner0).submitBatch(
  [treasuryAddress, treasuryAddress],
  [0, 0],
  [
    treasury.interface.encodeFunctionData("updateLimits", [dailyLimit, weeklyLimit, threshold]),
    treasury.interface.encodeFunctionData("updateTimelock", [3 * 24 * 60 * 60]),
  ]
);
// ...confirm both with all `sensitiveRequired` owners, advance past the timelock...
await treasury.connect(owner0).executeBatch([0, 1]);
```

Emergency pause procedures
--------------------------

A pause is the lighter-weight sibling of the freeze. It stops the treasury from
taking on new work while keeping funds recoverable:

| While paused                                  | Allowed |
| :-------------------------------------------- | :------ |
| Deposits (`receive`)                          | Yes     |
| `revokeConfirmation`                          | Yes     |
| `submitTransaction` / `submitBatch` (ordinary)| No      |
| `confirmTransaction` (ordinary proposals)     | No      |
| `executeTransaction` / `executeBatch`         | No      |
| `unpause`                                     | Yes     |
| `emergencyWithdraw`                           | Yes     |
| `emergencyFreeze` / `unfreezeInternal`        | Yes     |

The pause-exempt set is exactly `unpause`, `emergencyWithdraw`,
`emergencyFreeze` and `unfreezeInternal`. Because submission is gated too, the
only proposals that can be *created* while paused are those four, which is what
keeps a paused treasury from accumulating a backlog of approved work.

Revocation stays open on purpose: it withdraws authority rather than creating
new activity, so owners can dismantle pending approvals during an incident.

### 1. Pausing

```javascript
const pauseData = treasury.interface.encodeFunctionData("pause");
const txIndex = await treasury.connect(owner0).submitTransaction(treasuryAddress, 0, pauseData);

// `required` confirmations, no timelock — the pause takes effect on execution.
await treasury.connect(owner0).confirmTransaction(txIndex);
await treasury.connect(owner1).confirmTransaction(txIndex);
await treasury.connect(owner0).executeTransaction(txIndex);
// → Paused(address(this)) + ExecuteTransaction(owner0, txIndex)
```

### 2. Emergency withdrawal while paused

The escape hatch requires **unanimous** owner approval, has no timelock, and is
intentionally exempt from the daily/weekly spending windows — those limits exist
to pace routine spending, not to trap funds during an incident. It reverts
unless the treasury is paused.

```javascript
const withdrawData = treasury.interface.encodeFunctionData("emergencyWithdraw", [
  safeAddress,
  ethers.parseEther("2"),
]);
const txIndex = await treasury.connect(owner0).submitTransaction(treasuryAddress, 0, withdrawData);

// Every owner must confirm.
for (const owner of allOwners) {
  await treasury.connect(owner).confirmTransaction(txIndex);
}
await treasury.connect(owner0).executeTransaction(txIndex);
// → EmergencyWithdrawal(safeAddress, 2 ETH, remainingBalance)
```

Withdrawals can be batched, so a paused treasury can be drained to several
destinations in one atomic call:

```javascript
await treasury.connect(owner0).submitBatch(
  [treasuryAddress, treasuryAddress],
  [0, 0],
  [
    treasury.interface.encodeFunctionData("emergencyWithdraw", [coldStorage, amountA]),
    treasury.interface.encodeFunctionData("emergencyWithdraw", [opsWallet, amountB]),
  ]
);
// ...confirm both unanimously...
await treasury.connect(owner0).executeBatch([0, 1]);
```

### 3. Unpausing

```javascript
const unpauseData = treasury.interface.encodeFunctionData("unpause");
const txIndex = await treasury.connect(owner0).submitTransaction(treasuryAddress, 0, unpauseData);

// `sensitiveRequired` confirmations, but no timelock.
for (const owner of sensitiveQuorum) {
  await treasury.connect(owner).confirmTransaction(txIndex);
}
await treasury.connect(owner0).executeTransaction(txIndex);
// → Unpaused(address(this)) + ExecuteTransaction(owner0, txIndex)
```

Proposals that were fully approved before the pause resume immediately after the
unpause — nothing needs re-approving.

### Audit trail

`Paused` / `Unpaused` / `EmergencyWithdrawal` are emitted from the self-call, so
their `by` / `msg.sender` argument is the treasury address (matching the
existing `EmergencyFrozen` / `EmergencyUnfrozen` events). The owner who executed
the operation is identified by the `ExecuteTransaction(owner, txIndex)` event
emitted in the same transaction; join on the transaction hash to attribute a
pause to an owner.

### Escalating to a freeze

Pause and freeze are independent flags and a paused treasury can still be
frozen. A freeze is strictly stronger: it closes even the emergency-withdrawal
hatch, leaving `unfreezeInternal` as the only executable operation.

Emergency freeze / unfreeze
---------------------------

- Freeze: submit `emergencyFreeze()` as a self-call
  (`submitTransaction(address(this), 0, abi.encodeWithSelector(this.emergencyFreeze.selector))`),
  collect **all** owner confirmations, and execute — the freeze is effective
  immediately, no timelock.
- While frozen, only unfreeze proposals can be confirmed or executed; all other
  execution is blocked.
- Unfreeze: submit `unfreezeInternal()` as a self-call. It can be confirmed
  even while frozen and also requires unanimous approval with no timelock.

Timelock
--------

`timelockDelay` is bounded to `[1 days, 7 days]` (see `MIN_TIMELOCK_DELAY` /
`MAX_TIMELOCK_DELAY`). At submission, every proposal records
`minExecuteTime = block.timestamp + timelockDelay`; execution of timelocked
operations reverts with `timelock not elapsed` until that time passes. Changing
the delay affects **new** proposals only.

Quick test
----------

From the `Contracts` folder:

```bash
npm install      # or pnpm install
npx hardhat test test/MultisigTreasury.test.js
```

The suite covers timelock expiration, threshold variations (base vs sensitive
vs unanimous), concurrent proposals, revocations, emergency freeze/unfreeze,
governance parameter updates, reentrancy protection, and constructor validation.

For batch execution and the pause it additionally covers correlation-id
propagation across submit and execute events, partial batch failures (failing
external call, under-confirmed member, unelapsed timelock, duplicated index,
collectively breached daily limit) with full rollback assertions, the
`MAX_BATCH_SIZE` cap and full-batch gas usage, reentrancy into both
`executeBatch` and `executeTransaction` from inside a batch, pause/unpause
thresholds and events, every gate a pause applies, emergency withdrawals
(including argument validation and the spending-window bypass), and the
pause/freeze interaction.

Deployment
----------

See [DEPLOYMENT.md](./DEPLOYMENT.md) for governance initialization procedures
and [scripts/deploy/deploy.sh](./scripts/deploy/deploy.sh) for one-shot
deployment:

```bash
TREASURY_OWNERS="0xOwner1,0xOwner2,0xOwner3" \
TREASURY_REQUIRED=2 \
TREASURY_SENSITIVE_REQUIRED=3 \
TREASURY_TIMELOCK_DAYS=2 \
./scripts/deploy/deploy.sh
```

Governance runbook
------------------

See [docs/GOVERNANCE_GUIDE.md](./docs/GOVERNANCE_GUIDE.md) for the full
propose → confirm → timelock → execute runbook, monitoring guidance, and
emergency procedures.
