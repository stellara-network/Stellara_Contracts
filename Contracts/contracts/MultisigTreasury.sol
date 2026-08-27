// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract MultisigTreasury {
    event Deposit(address indexed sender, uint amount, uint balance);
    event SubmitTransaction(address indexed owner, uint indexed txIndex, address indexed to, uint value, bytes data, uint minExecuteTime);
    event ConfirmTransaction(address indexed owner, uint indexed txIndex);
    event RevokeConfirmation(address indexed owner, uint indexed txIndex);
    event ExecuteTransaction(address indexed owner, uint indexed txIndex);
    event LimitsUpdated(uint dailyLimit, uint weeklyLimit, uint threshold);
    event SensitiveRequiredUpdated(uint sensitiveRequired);
    event TimelockUpdated(uint timelockDelay);
    event EmergencyFrozen(address indexed by);
    event EmergencyUnfrozen(address indexed by);

    // Pause lifecycle. Distinct from the emergency freeze: a pause stops new
    // treasury activity but deliberately keeps the emergency withdrawal escape
    // hatch open, while a freeze blocks everything except the unfreeze itself.
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event EmergencyWithdrawal(address indexed to, uint amount, uint remainingBalance);

    // Batch lifecycle. Every batch carries a correlation id (`batchId`) that is
    // repeated on the per-transaction event so off-chain auditors can group the
    // members of a batch without replaying calldata.
    event BatchSubmitted(bytes32 indexed batchId, address indexed owner, uint count);
    event BatchTransactionSubmitted(bytes32 indexed batchId, uint indexed txIndex, uint position, address to, uint value);
    event BatchExecuted(bytes32 indexed batchId, address indexed executor, uint count);
    event BatchTransactionExecuted(bytes32 indexed batchId, uint indexed txIndex, uint position, address to, uint value);

    // Timelock bounds: risky operations are delayed by between 1 and 7 days.
    uint public constant MIN_TIMELOCK_DELAY = 1 days;
    uint public constant MAX_TIMELOCK_DELAY = 7 days;

    // Upper bound on the number of transactions in a single batch. Batches are
    // atomic, so an unbounded batch could be made to exceed the block gas limit
    // and become permanently unexecutable; bounding the size keeps the worst
    // case comfortably inside a block.
    uint public constant MAX_BATCH_SIZE = 20;

    address[] public owners;
    mapping(address => bool) public isOwner;
    uint public required;

    uint public dailyLimit;
    uint public weeklyLimit;
    uint public threshold;

    // Approval threshold for sensitive actions (parameter / governance changes).
    // Invariants: 0 < sensitiveRequired <= owners.length and
    // sensitiveRequired >= required.
    uint public sensitiveRequired;

    // Delay applied to risky operations at submission time.
    // Invariant: MIN_TIMELOCK_DELAY <= timelockDelay <= MAX_TIMELOCK_DELAY.
    uint public timelockDelay;

    bool public frozen;
    // Packed into the same storage slot as `frozen`, so appending it does not
    // shift any following slot (upgrade-safe).
    bool public paused;

    struct Transaction {
        address to;
        uint value;
        bytes data;
        bool executed;
        uint numConfirmations;
        uint created;
        // block.timestamp + timelockDelay at submission. Enforced only for
        // operations that are subject to the timelock (sensitive actions and
        // transfers above threshold); emergency and small transfers ignore it.
        uint minExecuteTime;
    }

    Transaction[] public transactions;
    mapping(uint => mapping(address => bool)) public isConfirmed;

    // tracking spend windows
    uint public dayWindowStart;
    uint public daySpent;
    uint public weekWindowStart;
    uint public weekSpent;

    bool private _entered;

    // Monotonic counter feeding batch correlation ids. Incremented once per
    // submitted or executed batch so ids are unique per contract.
    uint public batchNonce;

    modifier onlyOwner() { require(isOwner[msg.sender], "not owner"); _; }
    modifier notFrozen() { require(!frozen, "frozen"); _; }
    modifier nonReentrant() {
        require(!_entered, "reentrant call");
        _entered = true;
        _;
        _entered = false;
    }

    constructor(address[] memory _owners, uint _required, uint _dailyLimit, uint _weeklyLimit, uint _threshold, uint _sensitiveRequired, uint _timelockDelay) {
        require(_owners.length > 0, "owners required");
        require(_required > 0 && _required <= _owners.length, "invalid required");
        require(_sensitiveRequired > 0 && _sensitiveRequired <= _owners.length, "invalid sensitive required");
        require(_sensitiveRequired >= _required, "sensitive required below base required");
        require(_timelockDelay >= MIN_TIMELOCK_DELAY && _timelockDelay <= MAX_TIMELOCK_DELAY, "invalid timelock delay");
        for (uint i = 0; i < _owners.length; i++) {
            address o = _owners[i];
            require(o != address(0), "invalid owner");
            require(!isOwner[o], "owner not unique");
            isOwner[o] = true;
            owners.push(o);
        }
        required = _required;
        dailyLimit = _dailyLimit;
        weeklyLimit = _weeklyLimit;
        threshold = _threshold;
        sensitiveRequired = _sensitiveRequired;
        timelockDelay = _timelockDelay;
        dayWindowStart = block.timestamp / 1 days;
        weekWindowStart = block.timestamp / 1 weeks;
    }

    receive() external payable {
        emit Deposit(msg.sender, msg.value, address(this).balance);
    }

    function submitTransaction(address _to, uint _value, bytes calldata _data) external onlyOwner returns (uint) {
        return _submitTransaction(_to, _value, _data);
    }

    /**
     * @notice Submit an array of transactions as one correlated batch.
     * @dev All members are recorded under a single `batchId`; they are ordinary
     *      proposals afterwards (confirmed individually) and can later be
     *      executed atomically with {executeBatch}. Submission itself does not
     *      move funds, so it carries no atomicity concern beyond the implicit
     *      all-or-nothing behaviour of a single EVM transaction.
     */
    function submitBatch(address[] calldata _to, uint[] calldata _values, bytes[] calldata _data)
        external
        onlyOwner
        returns (uint[] memory txIndexes, bytes32 batchId)
    {
        require(_to.length > 0, "empty batch");
        require(_to.length <= MAX_BATCH_SIZE, "batch too large");
        require(_to.length == _values.length && _to.length == _data.length, "batch length mismatch");

        batchId = _nextBatchId();
        txIndexes = new uint[](_to.length);

        for (uint i = 0; i < _to.length; i++) {
            uint txIndex = _submitTransaction(_to[i], _values[i], _data[i]);
            txIndexes[i] = txIndex;
            emit BatchTransactionSubmitted(batchId, txIndex, i, _to[i], _values[i]);
        }

        emit BatchSubmitted(batchId, msg.sender, _to.length);
    }

    function confirmTransaction(uint _txIndex) external onlyOwner {
        require(_txIndex < transactions.length, "tx does not exist");
        Transaction storage txn = transactions[_txIndex];
        require(!txn.executed, "already executed");
        require(!isConfirmed[_txIndex][msg.sender], "already confirmed");

        bytes4 selector = _selfCallSelector(txn);

        // Allow confirming unfreeze calls even when frozen; all other txs require unfrozen state.
        if (frozen) {
            require(selector == this.unfreezeInternal.selector, "frozen");
        }

        // While paused, only the operations that are meant to remain available
        // (unpause and the emergency escape hatches) may gather confirmations.
        if (paused) {
            require(_isPauseExemptSelector(selector), "paused");
        }

        isConfirmed[_txIndex][msg.sender] = true;
        txn.numConfirmations += 1;
        emit ConfirmTransaction(msg.sender, _txIndex);
    }

    // Revoking is always permitted while a pause is in effect: it withdraws
    // authority rather than creating new activity.
    function revokeConfirmation(uint _txIndex) external onlyOwner notFrozen {
        require(_txIndex < transactions.length, "tx does not exist");
        Transaction storage txn = transactions[_txIndex];
        require(!txn.executed, "already executed");
        require(isConfirmed[_txIndex][msg.sender], "not confirmed");
        isConfirmed[_txIndex][msg.sender] = false;
        txn.numConfirmations -= 1;
        emit RevokeConfirmation(msg.sender, _txIndex);
    }

    function executeTransaction(uint _txIndex) external nonReentrant {
        _executeTransaction(_txIndex, bytes32(0), 0);
    }

    /**
     * @notice Execute an array of already-approved transactions atomically.
     * @dev Every member is subject to the exact same approval tier, timelock,
     *      pause/freeze and spending-limit checks as a single execution. Because
     *      the whole batch runs inside one EVM transaction, a revert anywhere —
     *      a missing confirmation, an unelapsed timelock, an exceeded limit or a
     *      failing external call — rolls the entire batch back: no member is
     *      marked executed and no funds move.
     * @param _txIndexes Proposal indexes to execute, in order.
     * @return batchId Correlation id repeated on each per-transaction event.
     */
    function executeBatch(uint[] calldata _txIndexes) external nonReentrant returns (bytes32 batchId) {
        require(_txIndexes.length > 0, "empty batch");
        require(_txIndexes.length <= MAX_BATCH_SIZE, "batch too large");

        batchId = _nextBatchId();

        for (uint i = 0; i < _txIndexes.length; i++) {
            _executeTransaction(_txIndexes[i], batchId, i);
        }

        emit BatchExecuted(batchId, msg.sender, _txIndexes.length);
    }

    function updateLimits(uint _dailyLimit, uint _weeklyLimit, uint _threshold) external {
        require(msg.sender == address(this), "only self");
        dailyLimit = _dailyLimit;
        weeklyLimit = _weeklyLimit;
        threshold = _threshold;
        emit LimitsUpdated(_dailyLimit, _weeklyLimit, _threshold);
    }

    function updateSensitiveRequired(uint _sensitiveRequired) external {
        require(msg.sender == address(this), "only self");
        require(_sensitiveRequired > 0 && _sensitiveRequired <= owners.length, "invalid sensitive required");
        require(_sensitiveRequired >= required, "sensitive required below base required");
        sensitiveRequired = _sensitiveRequired;
        emit SensitiveRequiredUpdated(_sensitiveRequired);
    }

    function updateTimelock(uint _timelockDelay) external {
        require(msg.sender == address(this), "only self");
        require(_timelockDelay >= MIN_TIMELOCK_DELAY && _timelockDelay <= MAX_TIMELOCK_DELAY, "invalid timelock delay");
        timelockDelay = _timelockDelay;
        emit TimelockUpdated(_timelockDelay);
    }

    /**
     * @notice Halt new treasury activity. Approved via multisig as a self-call
     *         (`required` confirmations, no timelock) so a pause can be applied
     *         quickly: pausing only ever removes capability.
     */
    function pause() external {
        require(msg.sender == address(this), "only self");
        require(!paused, "already paused");
        paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Resume treasury activity. Requires the higher `sensitiveRequired`
     *         threshold — restoring capability is the dangerous direction — and
     *         also bypasses the timelock so recovery is not delayed.
     */
    function unpause() external {
        require(msg.sender == address(this), "only self");
        require(paused, "not paused");
        paused = false;
        emit Unpaused(msg.sender);
    }

    /**
     * @notice Emergency escape hatch: move funds out of a paused treasury.
     * @dev Only callable as a self-call while paused, and only with unanimous
     *      owner approval (see the emergency tier in {_executeTransaction}).
     *      Because the proposal itself carries `value == 0` and the transfer
     *      happens here, an emergency withdrawal is intentionally exempt from
     *      the daily/weekly spending windows — the limits exist to pace routine
     *      spending, not to trap funds during an incident.
     */
    function emergencyWithdraw(address to, uint amount) external {
        require(msg.sender == address(this), "only self");
        require(paused, "not paused");
        require(to != address(0), "invalid recipient");
        require(amount > 0, "invalid amount");
        require(amount <= address(this).balance, "insufficient balance");

        (bool success, ) = to.call{ value: amount }("");
        require(success, "withdrawal failed");

        emit EmergencyWithdrawal(to, amount, address(this).balance);
    }

    // Emergency freeze must be approved via multisig to avoid a single-owner lockout.
    function emergencyFreeze() external {
        require(msg.sender == address(this), "only self");
        frozen = true;
        emit EmergencyFrozen(msg.sender);
    }

    // Unfreeze must be performed via an on-chain multisig transaction targeting this contract:
    // submitTransaction(address(this), 0, abi.encodeWithSelector(this.unfreezeInternal.selector))
    function unfreezeInternal() external {
        require(msg.sender == address(this), "only self");
        frozen = false;
        emit EmergencyUnfrozen(address(this));
    }

    // Helpers
    function getOwners() external view returns (address[] memory) { return owners; }
    function getTransactionCount() external view returns (uint) { return transactions.length; }
    function getTransaction(uint _txIndex) external view returns (address to, uint value, bytes memory data, bool executed, uint numConfirmations, uint created, uint minExecuteTime) {
        Transaction storage t = transactions[_txIndex];
        return (t.to, t.value, t.data, t.executed, t.numConfirmations, t.created, t.minExecuteTime);
    }

    function _submitTransaction(address _to, uint _value, bytes memory _data) internal returns (uint) {
        // A pause stops new activity, except for the operations that must stay
        // reachable while paused (unpause, emergency withdrawal, freeze/unfreeze).
        require(!paused || _isPauseExempt(_to, _data), "paused");

        uint minExecuteTime = block.timestamp + timelockDelay;
        transactions.push(Transaction({ to: _to, value: _value, data: _data, executed: false, numConfirmations: 0, created: block.timestamp, minExecuteTime: minExecuteTime }));
        uint txIndex = transactions.length - 1;
        emit SubmitTransaction(msg.sender, txIndex, _to, _value, _data, minExecuteTime);
        return txIndex;
    }

    /**
     * @dev Shared execution path for {executeTransaction} and {executeBatch}.
     *      `correlationId` is zero for a standalone execution; for a batch
     *      member it is the batch id and `position` its index in the batch.
     *      The caller is responsible for the reentrancy guard so that a batch
     *      holds the guard across all of its members.
     */
    function _executeTransaction(uint _txIndex, bytes32 correlationId, uint position) internal {
        require(_txIndex < transactions.length, "tx does not exist");
        Transaction storage txn = transactions[_txIndex];
        require(!txn.executed, "already executed");

        _authorizeExecution(txn);

        // Pre-execution state consistency validation.
        _validateStateInvariants();

        // Roll the spend windows forward and charge this transaction against
        // them. Within a batch these accumulate, so a batch that collectively
        // breaches a window reverts as a whole.
        _accountForSpend(txn.value);

        txn.executed = true;

        (bool success, ) = txn.to.call{ value: txn.value }(txn.data);
        require(success, "tx failed");

        // Post-execution state consistency validation: confirms the external
        // call (or any reentrant attempt) did not corrupt treasury invariants.
        _validateStateInvariants();
        require(txn.executed, "execution state corrupted");

        emit ExecuteTransaction(msg.sender, _txIndex);

        if (correlationId != bytes32(0)) {
            emit BatchTransactionExecuted(correlationId, _txIndex, position, txn.to, txn.value);
        }
    }

    /**
     * @dev Enforces the freeze/pause gates, the approval tier and the timelock
     *      for a single proposal. Reverting here aborts the whole enclosing
     *      call, which is what makes a batch all-or-nothing.
     */
    function _authorizeExecution(Transaction storage txn) internal view {
        // Classify the operation into one of its approval tiers. The self-call
        // selector is read once: a batch runs this path per member, so the
        // calldata copy is kept off the per-tier comparisons.
        bytes4 selector = _selfCallSelector(txn);

        bool isUnfreezeCall = selector == this.unfreezeInternal.selector;
        bool isUnpauseCall = selector == this.unpause.selector;
        bool isEmergency = isUnfreezeCall
            || selector == this.emergencyFreeze.selector
            || selector == this.emergencyWithdraw.selector;
        bool isSensitive = isUnpauseCall
            || selector == this.updateLimits.selector
            || selector == this.updateTimelock.selector
            || selector == this.updateSensitiveRequired.selector;

        require(!frozen || isUnfreezeCall, "frozen");
        require(!paused || _isPauseExemptSelector(selector), "paused");

        // Sensitive actions require a higher threshold than ordinary transfers.
        if (isEmergency) {
            // Emergency operations bypass the timelock but demand unanimity.
            require(txn.numConfirmations >= owners.length, "insufficient confirmations for emergency action");
        } else if (selector == this.pause.selector) {
            // Pausing only removes capability, so the base threshold suffices
            // and no timelock applies — an incident response must be fast.
            require(txn.numConfirmations >= required, "insufficient confirmations for pause action");
        } else if (isSensitive) {
            require(txn.numConfirmations >= sensitiveRequired, "insufficient confirmations for sensitive action");
        } else if (txn.value > threshold) {
            require(txn.numConfirmations >= required, "insufficient confirmations for large tx");
        } else {
            require(txn.numConfirmations >= 1, "requires at least one confirmation");
        }

        // Risky operations cannot execute before the timelock elapses. Unpause
        // is sensitive but time-critical, so it is exempt.
        if ((isSensitive && !isUnpauseCall) || txn.value > threshold) {
            require(block.timestamp >= txn.minExecuteTime, "timelock not elapsed");
        }
    }

    // Rolls the daily/weekly windows forward, enforces any configured limit and
    // records the spend.
    function _accountForSpend(uint value) internal {
        uint currentDay = block.timestamp / 1 days;
        if (dayWindowStart != currentDay) {
            dayWindowStart = currentDay;
            daySpent = 0;
        }
        uint currentWeek = block.timestamp / 1 weeks;
        if (weekWindowStart != currentWeek) {
            weekWindowStart = currentWeek;
            weekSpent = 0;
        }

        // Enforce limits if set (non-zero)
        if (dailyLimit > 0) {
            require(daySpent + value <= dailyLimit, "exceeds daily limit");
        }
        if (weeklyLimit > 0) {
            require(weekSpent + value <= weeklyLimit, "exceeds weekly limit");
        }

        daySpent += value;
        weekSpent += value;
    }

    // Derives a unique correlation id for a batch. Bound to this contract, the
    // caller, the chain and a monotonic nonce so ids never collide across
    // batches, callers or forks.
    function _nextBatchId() internal returns (bytes32) {
        batchNonce += 1;
        return keccak256(abi.encode(address(this), block.chainid, msg.sender, batchNonce));
    }

    // The 4-byte selector of a proposal that targets this contract, or zero for
    // proposals aimed elsewhere (plain transfers included).
    function _selfCallSelector(Transaction storage txn) internal view returns (bytes4) {
        if (txn.to != address(this)) return bytes4(0);
        bytes memory callData = txn.data;
        if (callData.length < 4) return bytes4(0);
        return bytes4(callData);
    }

    // Operations that remain available while the treasury is paused: unpausing
    // it, withdrawing funds through the emergency hatch, and escalating to or
    // recovering from a full freeze.
    function _isPauseExempt(address to, bytes memory data) internal view returns (bool) {
        if (to != address(this) || data.length < 4) return false;
        return _isPauseExemptSelector(bytes4(data));
    }

    function _isPauseExemptSelector(bytes4 selector) internal pure returns (bool) {
        return selector == MultisigTreasury.unpause.selector
            || selector == MultisigTreasury.emergencyWithdraw.selector
            || selector == MultisigTreasury.emergencyFreeze.selector
            || selector == MultisigTreasury.unfreezeInternal.selector;
    }

    // Validates that core governance and accounting invariants hold. Called
    // before execution (nothing may start from a corrupt state) and after
    // execution (the external call must not have corrupted the treasury).
    function _validateStateInvariants() internal view {
        require(required > 0 && required <= owners.length, "invalid required");
        require(sensitiveRequired > 0 && sensitiveRequired <= owners.length, "invalid sensitive required");
        require(sensitiveRequired >= required, "sensitive required below base required");
        require(timelockDelay >= MIN_TIMELOCK_DELAY && timelockDelay <= MAX_TIMELOCK_DELAY, "invalid timelock delay");
        if (dailyLimit > 0) {
            require(daySpent <= dailyLimit, "day spent exceeds daily limit");
        }
        if (weeklyLimit > 0) {
            require(weekSpent <= weeklyLimit, "week spent exceeds weekly limit");
        }
    }

    /**
     * @dev Storage gap to reserve space for future state variables when upgrading
     * via a proxy pattern. Reduces storage collision risk across upgrade versions.
     * Size: 46 slots (was 47; one further slot consumed by batchNonce, appended
     * before this gap. `paused` is packed into the existing `frozen` slot and so
     * consumes none).
     */
    uint256[46] private __gap;
}
