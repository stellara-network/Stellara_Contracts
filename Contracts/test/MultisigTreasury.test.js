const { expect } = require("chai");
const { ethers } = require("hardhat");

const DAY = 86400;
const TWO_DAYS = 2 * DAY;
const THREE_DAYS = 3 * DAY;
const EIGHT_DAYS = 8 * DAY;

describe("MultisigTreasury", function () {
  let owner0, owner1, owner2, recipient;
  let treasury;

  async function advanceTime(seconds) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  async function nextIndex() {
    return (await treasury.getTransactionCount()) - 1n;
  }

  async function submitTx(from, to, value, data = "0x") {
    await treasury.connect(from).submitTransaction(to, value, data);
    return nextIndex();
  }

  async function confirmBy(idx, ...signers) {
    for (const signer of signers) {
      await treasury.connect(signer).confirmTransaction(idx);
    }
  }

  async function deployTreasury(overrides = {}) {
    const owners = [owner0.address, owner1.address, owner2.address];
    const Multisig = await ethers.getContractFactory("MultisigTreasury");
    const inst = await Multisig.deploy(
      overrides.owners || owners,
      overrides.required !== undefined ? overrides.required : 2,
      overrides.dailyLimit !== undefined ? overrides.dailyLimit : ethers.parseEther("5"),
      overrides.weeklyLimit !== undefined ? overrides.weeklyLimit : ethers.parseEther("10"),
      overrides.threshold !== undefined ? overrides.threshold : ethers.parseEther("2"),
      overrides.sensitiveRequired !== undefined ? overrides.sensitiveRequired : 3,
      overrides.timelockDelay !== undefined ? overrides.timelockDelay : TWO_DAYS
    );
    await inst.waitForDeployment();
    return inst;
  }

  beforeEach(async () => {
    [owner0, owner1, owner2, recipient] = await ethers.getSigners();
    treasury = await deployTreasury();

    // Fund contract
    await owner0.sendTransaction({ to: await treasury.getAddress(), value: ethers.parseEther("5") });
  });

  it("executes a small single-confirm transaction immediately", async () => {
    const value = ethers.parseEther("0.5");
    const idx = await submitTx(owner0, recipient.address, value);
    await confirmBy(idx, owner0);
    const before = await ethers.provider.getBalance(recipient.address);
    await treasury.connect(owner0).executeTransaction(idx);
    const after = await ethers.provider.getBalance(recipient.address);
    expect(after - before).to.equal(value);
    // Post-execution accounting remains consistent.
    expect(await treasury.daySpent()).to.equal(value);
    expect(await treasury.weekSpent()).to.equal(value);
  });

  it("requires multisig and a timelock for large transactions above threshold", async () => {
    const value = ethers.parseEther("3"); // threshold is 2 ETH
    const idx = await submitTx(owner0, recipient.address, value);
    await confirmBy(idx, owner0);
    await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith(
      "insufficient confirmations for large tx"
    );

    await confirmBy(idx, owner1);
    await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith(
      "timelock not elapsed"
    );

    const txn = await treasury.getTransaction(idx);
    expect(txn.minExecuteTime).to.be.gt(0n);

    await advanceTime(TWO_DAYS);
    const before = await ethers.provider.getBalance(recipient.address);
    await treasury.connect(owner0).executeTransaction(idx);
    const after = await ethers.provider.getBalance(recipient.address);
    expect(after - before).to.equal(value);
  });

  it("requires the higher sensitive threshold and a timelock for parameter changes", async () => {
    const newDailyLimit = ethers.parseEther("2");
    const newWeeklyLimit = ethers.parseEther("12");
    const newThreshold = ethers.parseEther("3");
    const data = treasury.interface.encodeFunctionData("updateLimits", [
      newDailyLimit,
      newWeeklyLimit,
      newThreshold,
    ]);

    await expect(
      treasury.connect(owner0).updateLimits(newDailyLimit, newWeeklyLimit, newThreshold)
    ).to.be.revertedWith("only self");

    const idx = await submitTx(owner0, await treasury.getAddress(), 0n, data);
    await confirmBy(idx, owner0, owner1);
    // required (2) is insufficient for a sensitive action (sensitiveRequired = 3).
    await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith(
      "insufficient confirmations for sensitive action"
    );

    await confirmBy(idx, owner2);
    await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith(
      "timelock not elapsed"
    );

    await advanceTime(TWO_DAYS);
    await treasury.connect(owner0).executeTransaction(idx);

    expect(await treasury.dailyLimit()).to.equal(newDailyLimit);
    expect(await treasury.weeklyLimit()).to.equal(newWeeklyLimit);
    expect(await treasury.threshold()).to.equal(newThreshold);
  });

  it("requires unanimous approval and bypasses the timelock for emergency freeze", async () => {
    const data = treasury.interface.encodeFunctionData("emergencyFreeze");
    await expect(treasury.connect(owner0).emergencyFreeze()).to.be.revertedWith("only self");

    const idx = await submitTx(owner0, await treasury.getAddress(), 0n, data);
    await confirmBy(idx, owner0, owner1);
    await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith(
      "insufficient confirmations for emergency action"
    );

    // The third (unanimous) confirmation executes immediately — no timelock.
    await confirmBy(idx, owner2);
    await treasury.connect(owner0).executeTransaction(idx);
    expect(await treasury.frozen()).to.equal(true);

    // While frozen, ordinary transactions cannot even be confirmed.
    const paymentIdx = await submitTx(owner0, recipient.address, ethers.parseEther("0.1"));
    await expect(treasury.connect(owner0).confirmTransaction(paymentIdx)).to.be.revertedWith(
      "frozen"
    );
  });

  it("unfreezes unanimously, bypasses the timelock, and accepts confirmations while frozen", async () => {
    const paymentIdx = await submitTx(owner0, recipient.address, ethers.parseEther("0.1"));
    await confirmBy(paymentIdx, owner0);

    const freezeData = treasury.interface.encodeFunctionData("emergencyFreeze");
    const freezeIdx = await submitTx(owner0, await treasury.getAddress(), 0n, freezeData);
    await confirmBy(freezeIdx, owner0, owner1, owner2);
    await treasury.connect(owner0).executeTransaction(freezeIdx);
    expect(await treasury.frozen()).to.equal(true);

    // A non-unfreeze transaction cannot be confirmed while frozen.
    const blockedIdx = await submitTx(owner0, recipient.address, ethers.parseEther("0.1"));
    await expect(treasury.connect(owner0).confirmTransaction(blockedIdx)).to.be.revertedWith(
      "frozen"
    );

    // Unfreeze: confirmable even while frozen, executes immediately once unanimous.
    const unfreezeData = treasury.interface.encodeFunctionData("unfreezeInternal");
    const unfreezeIdx = await submitTx(owner0, await treasury.getAddress(), 0n, unfreezeData);
    await confirmBy(unfreezeIdx, owner0, owner1); // confirmed while frozen
    await confirmBy(unfreezeIdx, owner2); // still frozen
    await treasury.connect(owner0).executeTransaction(unfreezeIdx);
    expect(await treasury.frozen()).to.equal(false);

    // The previously queued payment now executes.
    const recipientBefore = await ethers.provider.getBalance(recipient.address);
    await treasury.connect(owner0).executeTransaction(paymentIdx);
    const recipientAfter = await ethers.provider.getBalance(recipient.address);
    expect(recipientAfter - recipientBefore).to.equal(ethers.parseEther("0.1"));
  });

  it("rejects invalid governance configuration at deployment", async () => {
    const owners = [owner0.address, owner1.address, owner2.address];
    const Multisig = await ethers.getContractFactory("MultisigTreasury");
    const base = [owners, 2, ethers.parseEther("5"), ethers.parseEther("10"), ethers.parseEther("2")];

    // sensitiveRequired out of range
    await expect(Multisig.deploy(...base, 4, TWO_DAYS)).to.be.revertedWith("invalid sensitive required");
    await expect(Multisig.deploy(...base, 0, TWO_DAYS)).to.be.revertedWith("invalid sensitive required");
    // sensitiveRequired below the base required
    await expect(Multisig.deploy(...base, 1, TWO_DAYS)).to.be.revertedWith("sensitive required below base required");
    // timelock outside the 1-7 day range
    await expect(Multisig.deploy(...base, 3, 0)).to.be.revertedWith("invalid timelock delay");
    await expect(Multisig.deploy(...base, 3, EIGHT_DAYS)).to.be.revertedWith("invalid timelock delay");
  });

  it("updates the timelock through the sensitive-action flow", async () => {
    const data = treasury.interface.encodeFunctionData("updateTimelock", [THREE_DAYS]);
    const idx = await submitTx(owner0, await treasury.getAddress(), 0n, data);
    await confirmBy(idx, owner0, owner1, owner2);
    await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith(
      "timelock not elapsed"
    );

    await advanceTime(TWO_DAYS);
    await treasury.connect(owner0).executeTransaction(idx);
    expect(await treasury.timelockDelay()).to.equal(THREE_DAYS);

    // New proposals inherit the updated delay.
    const data2 = treasury.interface.encodeFunctionData("updateTimelock", [TWO_DAYS]);
    const idx2 = await submitTx(owner0, await treasury.getAddress(), 0n, data2);
    await confirmBy(idx2, owner0, owner1, owner2);
    await expect(treasury.connect(owner0).executeTransaction(idx2)).to.be.revertedWith(
      "timelock not elapsed"
    );

    await advanceTime(THREE_DAYS);
    await treasury.connect(owner0).executeTransaction(idx2);
    expect(await treasury.timelockDelay()).to.equal(TWO_DAYS);
  });

  it("enforces sensitive threshold variations after governance updates", async () => {
    const data = treasury.interface.encodeFunctionData("updateSensitiveRequired", [2]);
    const idx = await submitTx(owner0, await treasury.getAddress(), 0n, data);
    await confirmBy(idx, owner0, owner1, owner2);
    await advanceTime(TWO_DAYS);
    await treasury.connect(owner0).executeTransaction(idx);
    expect(await treasury.sensitiveRequired()).to.equal(2n);

    // A sensitive action now needs only 2 confirmations (still timelocked).
    const data2 = treasury.interface.encodeFunctionData("updateLimits", [
      ethers.parseEther("1"),
      ethers.parseEther("11"),
      ethers.parseEther("4"),
    ]);
    const idx2 = await submitTx(owner0, await treasury.getAddress(), 0n, data2);
    await confirmBy(idx2, owner0, owner1);
    await expect(treasury.connect(owner0).executeTransaction(idx2)).to.be.revertedWith(
      "timelock not elapsed"
    );

    await advanceTime(TWO_DAYS);
    await treasury.connect(owner0).executeTransaction(idx2);
    expect(await treasury.dailyLimit()).to.equal(ethers.parseEther("1"));
  });

  it("rejects out-of-range governance updates at execution", async () => {
    // updateSensitiveRequired below the base required fails inside the self-call.
    const data = treasury.interface.encodeFunctionData("updateSensitiveRequired", [1]);
    const idx = await submitTx(owner0, await treasury.getAddress(), 0n, data);
    await confirmBy(idx, owner0, owner1, owner2);
    await advanceTime(TWO_DAYS);
    await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith("tx failed");
    expect(await treasury.sensitiveRequired()).to.equal(3n);

    // updateTimelock beyond 7 days fails inside the self-call.
    const data2 = treasury.interface.encodeFunctionData("updateTimelock", [EIGHT_DAYS]);
    const idx2 = await submitTx(owner0, await treasury.getAddress(), 0n, data2);
    await confirmBy(idx2, owner0, owner1, owner2);
    await advanceTime(TWO_DAYS);
    await expect(treasury.connect(owner0).executeTransaction(idx2)).to.be.revertedWith("tx failed");
    expect(await treasury.timelockDelay()).to.equal(TWO_DAYS);
  });

  it("tracks concurrent proposals with independent confirmation state", async () => {
    const small = ethers.parseEther("0.5");
    const large = ethers.parseEther("3");

    const smallIdxA = await submitTx(owner0, recipient.address, small);
    const smallIdxB = await submitTx(owner1, recipient.address, small);
    const largeIdx = await submitTx(owner2, recipient.address, large);

    await confirmBy(smallIdxA, owner0);
    await confirmBy(largeIdx, owner0);
    await confirmBy(largeIdx, owner1);

    // Confirmations are tracked per proposal.
    expect((await treasury.getTransaction(smallIdxA)).numConfirmations).to.equal(1n);
    expect((await treasury.getTransaction(smallIdxB)).numConfirmations).to.equal(0n);
    expect((await treasury.getTransaction(largeIdx)).numConfirmations).to.equal(2n);

    // Executing one proposal leaves the others untouched.
    const before = await ethers.provider.getBalance(recipient.address);
    await treasury.connect(owner0).executeTransaction(smallIdxA);
    const after = await ethers.provider.getBalance(recipient.address);
    expect(after - before).to.equal(small);
    expect((await treasury.getTransaction(smallIdxB)).executed).to.equal(false);
    expect((await treasury.getTransaction(largeIdx)).executed).to.equal(false);

    // An unconfirmed proposal cannot execute.
    await expect(treasury.connect(owner1).executeTransaction(smallIdxB)).to.be.revertedWith(
      "requires at least one confirmation"
    );

    // The large proposal still respects its timelock.
    await expect(treasury.connect(owner2).executeTransaction(largeIdx)).to.be.revertedWith(
      "timelock not elapsed"
    );
    await advanceTime(TWO_DAYS);
    await treasury.connect(owner2).executeTransaction(largeIdx);
    expect((await treasury.getTransaction(largeIdx)).executed).to.equal(true);
  });

  it("allows revoking a confirmation before execution", async () => {
    const idx = await submitTx(owner0, recipient.address, ethers.parseEther("0.5"));
    await confirmBy(idx, owner0);
    expect((await treasury.getTransaction(idx)).numConfirmations).to.equal(1n);

    await treasury.connect(owner0).revokeConfirmation(idx);
    expect((await treasury.getTransaction(idx)).numConfirmations).to.equal(0n);

    await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith(
      "requires at least one confirmation"
    );
  });

  it("blocks reentrant execution attempts", async () => {
    const Attacker = await ethers.getContractFactory("ReentrancyAttacker");
    const attacker = await Attacker.deploy();
    await attacker.waitForDeployment();
    const attackerAddress = await attacker.getAddress();

    // Payable proposal to the attacker triggers receive() during execution.
    const attackIdx = await submitTx(owner0, attackerAddress, 0n, "0x");
    await confirmBy(attackIdx, owner0);

    // Fully-approved second proposal the attacker tries to execute reentrantly.
    const value = ethers.parseEther("1");
    const targetIdx = await submitTx(owner0, recipient.address, value);
    await confirmBy(targetIdx, owner0);

    await attacker.arm(await treasury.getAddress(), Number(targetIdx));

    const recipientBefore = await ethers.provider.getBalance(recipient.address);
    await treasury.connect(owner0).executeTransaction(attackIdx);
    const recipientAfter = await ethers.provider.getBalance(recipient.address);

    expect(await attacker.reentered()).to.equal(true);
    expect(await attacker.reentrantCallSucceeded()).to.equal(false);
    expect(recipientAfter - recipientBefore).to.equal(0n);

    const txn = await treasury.getTransaction(targetIdx);
    expect(txn.executed).to.equal(false);
  });

  it("exposes the hardened governance storage layout with reserved gap slots", async () => {
    expect(await treasury.required()).to.equal(2n);
    expect(await treasury.dailyLimit()).to.equal(ethers.parseEther("5"));
    expect(await treasury.weeklyLimit()).to.equal(ethers.parseEther("10"));
    expect(await treasury.threshold()).to.equal(ethers.parseEther("2"));
    expect(await treasury.sensitiveRequired()).to.equal(3n);
    expect(await treasury.timelockDelay()).to.equal(2n * 86400n);
    expect(await treasury.MIN_TIMELOCK_DELAY()).to.equal(1n * 86400n);
    expect(await treasury.MAX_TIMELOCK_DELAY()).to.equal(7n * 86400n);
    expect(await treasury.frozen()).to.equal(false);
    expect(await treasury.paused()).to.equal(false);
    expect(await treasury.batchNonce()).to.equal(0n);
    expect(await treasury.MAX_BATCH_SIZE()).to.equal(20n);
    const owners = await treasury.getOwners();
    expect(owners.length).to.equal(3);
  });

  function parseLogs(receipt) {
    return receipt.logs
      .map((log) => {
        try {
          return treasury.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  async function submitBatchTx(from, tos, values, datas) {
    const start = await treasury.getTransactionCount();
    const receipt = await (await treasury.connect(from).submitBatch(tos, values, datas)).wait();
    return { receipt, indexes: tos.map((_, i) => start + BigInt(i)) };
  }

  describe("batch execution", function () {
    it("submits an array of transactions as one correlated batch", async () => {
      const values = [ethers.parseEther("0.1"), ethers.parseEther("0.2")];
      const { receipt, indexes } = await submitBatchTx(
        owner0,
        [recipient.address, recipient.address],
        values,
        ["0x", "0x"]
      );

      const events = parseLogs(receipt);
      const submitted = events.find((e) => e.name === "BatchSubmitted");
      const members = events.filter((e) => e.name === "BatchTransactionSubmitted");

      expect(submitted.args.owner).to.equal(owner0.address);
      expect(submitted.args.count).to.equal(2n);
      expect(members.length).to.equal(2);
      members.forEach((event, i) => {
        // Every member repeats the batch correlation id and its position.
        expect(event.args.batchId).to.equal(submitted.args.batchId);
        expect(event.args.txIndex).to.equal(indexes[i]);
        expect(event.args.position).to.equal(BigInt(i));
        expect(event.args.to).to.equal(recipient.address);
        expect(event.args.value).to.equal(values[i]);
      });

      expect(await treasury.getTransactionCount()).to.equal(2n);
      expect(await treasury.batchNonce()).to.equal(1n);
    });

    it("rejects malformed batch submissions", async () => {
      await expect(treasury.connect(owner0).submitBatch([], [], [])).to.be.revertedWith("empty batch");
      await expect(
        treasury.connect(owner0).submitBatch([recipient.address], [], [])
      ).to.be.revertedWith("batch length mismatch");
      await expect(
        treasury.connect(owner0).submitBatch([recipient.address], [1n], [])
      ).to.be.revertedWith("batch length mismatch");

      const oversize = 21;
      await expect(
        treasury
          .connect(owner0)
          .submitBatch(
            Array(oversize).fill(recipient.address),
            Array(oversize).fill(0n),
            Array(oversize).fill("0x")
          )
      ).to.be.revertedWith("batch too large");

      // Non-owners cannot open a batch.
      await expect(
        treasury.connect(recipient).submitBatch([recipient.address], [0n], ["0x"])
      ).to.be.revertedWith("not owner");
    });

    it("executes a batch atomically and correlates every transaction event", async () => {
      const value = ethers.parseEther("0.5");
      const idxA = await submitTx(owner0, recipient.address, value);
      const idxB = await submitTx(owner1, recipient.address, value);
      await confirmBy(idxA, owner0);
      await confirmBy(idxB, owner1);

      const before = await ethers.provider.getBalance(recipient.address);
      const receipt = await (await treasury.connect(owner0).executeBatch([idxA, idxB])).wait();
      const after = await ethers.provider.getBalance(recipient.address);
      expect(after - before).to.equal(value * 2n);

      const events = parseLogs(receipt);
      const executed = events.find((e) => e.name === "BatchExecuted");
      const members = events.filter((e) => e.name === "BatchTransactionExecuted");

      expect(executed.args.executor).to.equal(owner0.address);
      expect(executed.args.count).to.equal(2n);
      expect(members.length).to.equal(2);
      [idxA, idxB].forEach((txIndex, i) => {
        expect(members[i].args.batchId).to.equal(executed.args.batchId);
        expect(members[i].args.txIndex).to.equal(txIndex);
        expect(members[i].args.position).to.equal(BigInt(i));
        expect(members[i].args.value).to.equal(value);
      });

      // The per-transaction audit trail is preserved alongside the batch events.
      expect(events.filter((e) => e.name === "ExecuteTransaction").length).to.equal(2);

      expect((await treasury.getTransaction(idxA)).executed).to.equal(true);
      expect((await treasury.getTransaction(idxB)).executed).to.equal(true);
      expect(await treasury.daySpent()).to.equal(value * 2n);
      expect(await treasury.weekSpent()).to.equal(value * 2n);
    });

    it("assigns a distinct correlation id to each batch", async () => {
      const value = ethers.parseEther("0.1");
      const ids = [];
      for (let i = 0; i < 2; i++) {
        const idx = await submitTx(owner0, recipient.address, value);
        await confirmBy(idx, owner0);
        const receipt = await (await treasury.connect(owner0).executeBatch([idx])).wait();
        ids.push(parseLogs(receipt).find((e) => e.name === "BatchExecuted").args.batchId);
      }
      expect(ids[0]).to.not.equal(ids[1]);
      expect(await treasury.batchNonce()).to.equal(2n);
    });

    it("rolls the whole batch back when a member's external call fails", async () => {
      const Rejecting = await ethers.getContractFactory("RejectingReceiver");
      const rejecting = await Rejecting.deploy();
      await rejecting.waitForDeployment();

      const value = ethers.parseEther("0.5");
      const okIdx = await submitTx(owner0, recipient.address, value);
      const badIdx = await submitTx(owner0, await rejecting.getAddress(), value);
      await confirmBy(okIdx, owner0);
      await confirmBy(badIdx, owner0);

      const before = await ethers.provider.getBalance(recipient.address);
      await expect(treasury.connect(owner0).executeBatch([okIdx, badIdx])).to.be.revertedWith(
        "tx failed"
      );
      const after = await ethers.provider.getBalance(recipient.address);

      // Nothing from the batch survived: no transfer, no executed flag, no spend.
      expect(after - before).to.equal(0n);
      expect((await treasury.getTransaction(okIdx)).executed).to.equal(false);
      expect((await treasury.getTransaction(badIdx)).executed).to.equal(false);
      expect(await treasury.daySpent()).to.equal(0n);
    });

    it("rolls the whole batch back when a member is not sufficiently confirmed", async () => {
      const value = ethers.parseEther("0.5");
      const okIdx = await submitTx(owner0, recipient.address, value);
      const unconfirmedIdx = await submitTx(owner0, recipient.address, value);
      await confirmBy(okIdx, owner0);

      await expect(
        treasury.connect(owner0).executeBatch([okIdx, unconfirmedIdx])
      ).to.be.revertedWith("requires at least one confirmation");
      expect((await treasury.getTransaction(okIdx)).executed).to.equal(false);
      expect(await treasury.daySpent()).to.equal(0n);
    });

    it("rolls the whole batch back when a member's timelock has not elapsed", async () => {
      const smallIdx = await submitTx(owner0, recipient.address, ethers.parseEther("0.5"));
      await confirmBy(smallIdx, owner0);
      const largeIdx = await submitTx(owner0, recipient.address, ethers.parseEther("3"));
      await confirmBy(largeIdx, owner0, owner1);

      await expect(treasury.connect(owner0).executeBatch([smallIdx, largeIdx])).to.be.revertedWith(
        "timelock not elapsed"
      );
      expect((await treasury.getTransaction(smallIdx)).executed).to.equal(false);

      // Once the timelock elapses the same batch succeeds as a unit.
      await advanceTime(TWO_DAYS);
      const before = await ethers.provider.getBalance(recipient.address);
      await treasury.connect(owner0).executeBatch([smallIdx, largeIdx]);
      const after = await ethers.provider.getBalance(recipient.address);
      expect(after - before).to.equal(ethers.parseEther("3.5"));
    });

    it("rolls the whole batch back on a duplicated index", async () => {
      const idx = await submitTx(owner0, recipient.address, ethers.parseEther("0.5"));
      await confirmBy(idx, owner0);

      await expect(treasury.connect(owner0).executeBatch([idx, idx])).to.be.revertedWith(
        "already executed"
      );
      expect((await treasury.getTransaction(idx)).executed).to.equal(false);
      expect(await treasury.daySpent()).to.equal(0n);
    });

    it("rolls the whole batch back when members collectively exceed the daily limit", async () => {
      // dailyLimit is 5 ETH; each member is at the 2 ETH threshold so it needs a
      // single confirmation, but the three together breach the window.
      const value = ethers.parseEther("2");
      const indexes = [];
      for (let i = 0; i < 3; i++) {
        const idx = await submitTx(owner0, recipient.address, value);
        await confirmBy(idx, owner0);
        indexes.push(idx);
      }

      await expect(treasury.connect(owner0).executeBatch(indexes)).to.be.revertedWith(
        "exceeds daily limit"
      );
      for (const idx of indexes) {
        expect((await treasury.getTransaction(idx)).executed).to.equal(false);
      }
      expect(await treasury.daySpent()).to.equal(0n);
      expect(await ethers.provider.getBalance(await treasury.getAddress())).to.equal(
        ethers.parseEther("5")
      );

      // The first two members alone fit inside the window.
      await treasury.connect(owner0).executeBatch(indexes.slice(0, 2));
      expect(await treasury.daySpent()).to.equal(ethers.parseEther("4"));
    });

    it("bounds the batch size and keeps a full-size batch inside the block gas limit", async () => {
      treasury = await deployTreasury({
        dailyLimit: ethers.parseEther("100"),
        weeklyLimit: ethers.parseEther("200"),
      });
      await owner0.sendTransaction({
        to: await treasury.getAddress(),
        value: ethers.parseEther("10"),
      });

      const maxBatchSize = Number(await treasury.MAX_BATCH_SIZE());
      const indexes = [];
      for (let i = 0; i < maxBatchSize; i++) {
        const idx = await submitTx(owner0, recipient.address, ethers.parseEther("0.1"));
        await confirmBy(idx, owner0);
        indexes.push(idx);
      }

      await expect(treasury.connect(owner0).executeBatch([])).to.be.revertedWith("empty batch");
      await expect(
        treasury.connect(owner0).executeBatch([...indexes, indexes[0]])
      ).to.be.revertedWith("batch too large");

      const before = await ethers.provider.getBalance(recipient.address);
      const receipt = await (await treasury.connect(owner0).executeBatch(indexes)).wait();
      const after = await ethers.provider.getBalance(recipient.address);
      expect(after - before).to.equal(ethers.parseEther("0.1") * BigInt(maxBatchSize));

      // A full batch stays well inside a mainnet block (30M gas), so a capped
      // batch can never become unexecutable.
      // A full 20-transfer batch costs ~1.15M gas, so a size-capped batch can
      // never grow past a block gas limit and become unexecutable.
      expect(receipt.gasUsed).to.be.lt(2_000_000n);
    });

    it("blocks reentrant batch execution", async () => {
      const Attacker = await ethers.getContractFactory("BatchReentrancyAttacker");
      const attacker = await Attacker.deploy();
      await attacker.waitForDeployment();

      const attackIdx = await submitTx(owner0, await attacker.getAddress(), 0n, "0x");
      await confirmBy(attackIdx, owner0);

      const value = ethers.parseEther("1");
      const targetIdx = await submitTx(owner0, recipient.address, value);
      await confirmBy(targetIdx, owner0);

      await attacker.arm(await treasury.getAddress(), [targetIdx]);

      const before = await ethers.provider.getBalance(recipient.address);
      await treasury.connect(owner0).executeBatch([attackIdx]);
      const after = await ethers.provider.getBalance(recipient.address);

      expect(await attacker.reentered()).to.equal(true);
      expect(await attacker.reentrantCallSucceeded()).to.equal(false);
      expect(after - before).to.equal(0n);
      expect((await treasury.getTransaction(targetIdx)).executed).to.equal(false);
    });

    it("blocks a reentrant single execution launched from inside a batch", async () => {
      const Attacker = await ethers.getContractFactory("ReentrancyAttacker");
      const attacker = await Attacker.deploy();
      await attacker.waitForDeployment();

      const attackIdx = await submitTx(owner0, await attacker.getAddress(), 0n, "0x");
      await confirmBy(attackIdx, owner0);

      const targetIdx = await submitTx(owner0, recipient.address, ethers.parseEther("1"));
      await confirmBy(targetIdx, owner0);

      await attacker.arm(await treasury.getAddress(), Number(targetIdx));
      await treasury.connect(owner0).executeBatch([attackIdx]);

      expect(await attacker.reentered()).to.equal(true);
      expect(await attacker.reentrantCallSucceeded()).to.equal(false);
      expect((await treasury.getTransaction(targetIdx)).executed).to.equal(false);
    });

    it("applies correlated governance changes atomically after the timelock", async () => {
      const treasuryAddress = await treasury.getAddress();
      const limitsData = treasury.interface.encodeFunctionData("updateLimits", [
        ethers.parseEther("4"),
        ethers.parseEther("9"),
        ethers.parseEther("1"),
      ]);
      const timelockData = treasury.interface.encodeFunctionData("updateTimelock", [THREE_DAYS]);

      const { indexes } = await submitBatchTx(
        owner0,
        [treasuryAddress, treasuryAddress],
        [0n, 0n],
        [limitsData, timelockData]
      );
      for (const idx of indexes) {
        await confirmBy(idx, owner0, owner1, owner2);
      }

      await expect(treasury.connect(owner0).executeBatch(indexes)).to.be.revertedWith(
        "timelock not elapsed"
      );
      expect(await treasury.dailyLimit()).to.equal(ethers.parseEther("5"));

      await advanceTime(TWO_DAYS);
      await treasury.connect(owner0).executeBatch(indexes);
      expect(await treasury.dailyLimit()).to.equal(ethers.parseEther("4"));
      expect(await treasury.weeklyLimit()).to.equal(ethers.parseEther("9"));
      expect(await treasury.threshold()).to.equal(ethers.parseEther("1"));
      expect(await treasury.timelockDelay()).to.equal(THREE_DAYS);
    });
  });

  describe("emergency pause", function () {
    async function proposePause(...confirmers) {
      const data = treasury.interface.encodeFunctionData("pause");
      const idx = await submitTx(owner0, await treasury.getAddress(), 0n, data);
      await confirmBy(idx, ...confirmers);
      return idx;
    }

    async function pauseTreasury() {
      const idx = await proposePause(owner0, owner1);
      const tx = await treasury.connect(owner0).executeTransaction(idx);
      return { idx, tx };
    }

    async function proposeWithdrawal(to, amount, ...confirmers) {
      const data = treasury.interface.encodeFunctionData("emergencyWithdraw", [to, amount]);
      const idx = await submitTx(owner0, await treasury.getAddress(), 0n, data);
      await confirmBy(idx, ...confirmers);
      return idx;
    }

    it("pauses with the base threshold and no timelock, and is auditable", async () => {
      await expect(treasury.connect(owner0).pause()).to.be.revertedWith("only self");

      const treasuryAddress = await treasury.getAddress();
      const { idx, tx } = await pauseTreasury();

      // The pause event records the state change; the paired ExecuteTransaction
      // event in the same transaction identifies the acting owner.
      await expect(tx).to.emit(treasury, "Paused").withArgs(treasuryAddress);
      await expect(tx).to.emit(treasury, "ExecuteTransaction").withArgs(owner0.address, idx);
      expect(await treasury.paused()).to.equal(true);
      expect(await treasury.frozen()).to.equal(false);
    });

    it("rejects a pause below the base threshold", async () => {
      const idx = await proposePause(owner0);
      await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith(
        "insufficient confirmations for pause action"
      );
      expect(await treasury.paused()).to.equal(false);
    });

    it("prevents new operations while paused", async () => {
      const treasuryAddress = await treasury.getAddress();
      const approvedIdx = await submitTx(owner0, recipient.address, ethers.parseEther("0.5"));
      await confirmBy(approvedIdx, owner0);
      const pendingIdx = await submitTx(owner0, recipient.address, ethers.parseEther("0.5"));

      await pauseTreasury();

      await expect(submitTx(owner0, recipient.address, ethers.parseEther("0.1"))).to.be.revertedWith(
        "paused"
      );
      await expect(treasury.connect(owner1).confirmTransaction(pendingIdx)).to.be.revertedWith(
        "paused"
      );
      await expect(treasury.connect(owner0).executeTransaction(approvedIdx)).to.be.revertedWith(
        "paused"
      );
      await expect(treasury.connect(owner0).executeBatch([approvedIdx])).to.be.revertedWith(
        "paused"
      );

      // A pause is not itself pause-exempt, so it cannot be re-proposed.
      const pauseData = treasury.interface.encodeFunctionData("pause");
      await expect(submitTx(owner0, treasuryAddress, 0n, pauseData)).to.be.revertedWith("paused");
      // Nor are ordinary governance changes.
      const limitsData = treasury.interface.encodeFunctionData("updateLimits", [0n, 0n, 0n]);
      await expect(submitTx(owner0, treasuryAddress, 0n, limitsData)).to.be.revertedWith("paused");
    });

    it("still accepts deposits and confirmation revocations while paused", async () => {
      const idx = await submitTx(owner0, recipient.address, ethers.parseEther("0.5"));
      await confirmBy(idx, owner0);
      await pauseTreasury();

      const treasuryAddress = await treasury.getAddress();
      await owner0.sendTransaction({ to: treasuryAddress, value: ethers.parseEther("1") });
      expect(await ethers.provider.getBalance(treasuryAddress)).to.equal(ethers.parseEther("6"));

      await treasury.connect(owner0).revokeConfirmation(idx);
      expect((await treasury.getTransaction(idx)).numConfirmations).to.equal(0n);
    });

    it("allows emergency withdrawals while paused, bypassing the spending windows", async () => {
      await pauseTreasury();

      // dailyLimit is 5 ETH and 2 ETH of it is untouched, yet the withdrawal is
      // not charged against the window at all.
      const amount = ethers.parseEther("2");
      const idx = await proposeWithdrawal(recipient.address, amount, owner0, owner1, owner2);

      const before = await ethers.provider.getBalance(recipient.address);
      const tx = await treasury.connect(owner0).executeTransaction(idx);
      const after = await ethers.provider.getBalance(recipient.address);

      expect(after - before).to.equal(amount);
      await expect(tx)
        .to.emit(treasury, "EmergencyWithdrawal")
        .withArgs(recipient.address, amount, ethers.parseEther("3"));
      await expect(tx).to.emit(treasury, "ExecuteTransaction").withArgs(owner0.address, idx);
      expect(await treasury.daySpent()).to.equal(0n);
      expect(await treasury.weekSpent()).to.equal(0n);
      expect(await treasury.paused()).to.equal(true);
    });

    it("requires unanimous approval for an emergency withdrawal", async () => {
      await pauseTreasury();
      const idx = await proposeWithdrawal(recipient.address, ethers.parseEther("1"), owner0, owner1);
      await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith(
        "insufficient confirmations for emergency action"
      );
    });

    it("rejects emergency withdrawals when the treasury is not paused", async () => {
      await expect(
        treasury.connect(owner0).emergencyWithdraw(recipient.address, ethers.parseEther("1"))
      ).to.be.revertedWith("only self");

      const idx = await proposeWithdrawal(
        recipient.address,
        ethers.parseEther("1"),
        owner0,
        owner1,
        owner2
      );
      await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith("tx failed");
      expect(await ethers.provider.getBalance(await treasury.getAddress())).to.equal(
        ethers.parseEther("5")
      );
    });

    it("validates emergency withdrawal arguments", async () => {
      await pauseTreasury();
      const cases = [
        [ethers.ZeroAddress, ethers.parseEther("1")],
        [recipient.address, 0n],
        [recipient.address, ethers.parseEther("6")], // more than the balance
      ];
      for (const [to, amount] of cases) {
        const idx = await proposeWithdrawal(to, amount, owner0, owner1, owner2);
        await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith(
          "tx failed"
        );
      }
      expect(await ethers.provider.getBalance(await treasury.getAddress())).to.equal(
        ethers.parseEther("5")
      );
    });

    it("batches emergency withdrawals while paused", async () => {
      await pauseTreasury();
      const treasuryAddress = await treasury.getAddress();
      const first = ethers.parseEther("1");
      const second = ethers.parseEther("2");

      const { indexes } = await submitBatchTx(
        owner0,
        [treasuryAddress, treasuryAddress],
        [0n, 0n],
        [
          treasury.interface.encodeFunctionData("emergencyWithdraw", [recipient.address, first]),
          treasury.interface.encodeFunctionData("emergencyWithdraw", [owner2.address, second]),
        ]
      );
      for (const idx of indexes) {
        await confirmBy(idx, owner0, owner1, owner2);
      }

      const before = await ethers.provider.getBalance(recipient.address);
      const receipt = await (await treasury.connect(owner0).executeBatch(indexes)).wait();
      const after = await ethers.provider.getBalance(recipient.address);

      expect(after - before).to.equal(first);
      expect(await ethers.provider.getBalance(treasuryAddress)).to.equal(ethers.parseEther("2"));

      const events = parseLogs(receipt);
      const batchId = events.find((e) => e.name === "BatchExecuted").args.batchId;
      const members = events.filter((e) => e.name === "BatchTransactionExecuted");
      expect(members.length).to.equal(2);
      expect(members.every((e) => e.args.batchId === batchId)).to.equal(true);
      expect(events.filter((e) => e.name === "EmergencyWithdrawal").length).to.equal(2);
    });

    it("rejects a batch containing a non-exempt operation while paused", async () => {
      const treasuryAddress = await treasury.getAddress();
      const paymentIdx = await submitTx(owner0, recipient.address, ethers.parseEther("0.5"));
      await confirmBy(paymentIdx, owner0);

      await pauseTreasury();

      const withdrawIdx = await proposeWithdrawal(
        recipient.address,
        ethers.parseEther("1"),
        owner0,
        owner1,
        owner2
      );

      await expect(
        treasury.connect(owner0).executeBatch([withdrawIdx, paymentIdx])
      ).to.be.revertedWith("paused");
      expect(await ethers.provider.getBalance(treasuryAddress)).to.equal(ethers.parseEther("5"));
      expect((await treasury.getTransaction(withdrawIdx)).executed).to.equal(false);
    });

    it("unpauses with the sensitive threshold and no timelock, restoring operations", async () => {
      const treasuryAddress = await treasury.getAddress();
      const paymentIdx = await submitTx(owner0, recipient.address, ethers.parseEther("0.5"));
      await confirmBy(paymentIdx, owner0);

      await pauseTreasury();

      const data = treasury.interface.encodeFunctionData("unpause");
      const idx = await submitTx(owner0, treasuryAddress, 0n, data);
      await confirmBy(idx, owner0, owner1);
      // Unpausing restores capability, so it needs sensitiveRequired (3), not required (2).
      await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith(
        "insufficient confirmations for sensitive action"
      );

      await confirmBy(idx, owner2);
      // No time is advanced: unpause is deliberately exempt from the timelock.
      const tx = await treasury.connect(owner0).executeTransaction(idx);
      await expect(tx).to.emit(treasury, "Unpaused").withArgs(treasuryAddress);
      await expect(tx).to.emit(treasury, "ExecuteTransaction").withArgs(owner0.address, idx);
      expect(await treasury.paused()).to.equal(false);

      // Operations queued before the pause resume, and new ones are accepted.
      const before = await ethers.provider.getBalance(recipient.address);
      await treasury.connect(owner0).executeTransaction(paymentIdx);
      const after = await ethers.provider.getBalance(recipient.address);
      expect(after - before).to.equal(ethers.parseEther("0.5"));

      const newIdx = await submitTx(owner0, recipient.address, ethers.parseEther("0.1"));
      await confirmBy(newIdx, owner0);
      await treasury.connect(owner0).executeTransaction(newIdx);
      expect((await treasury.getTransaction(newIdx)).executed).to.equal(true);
    });

    it("rejects an unpause when the treasury is not paused", async () => {
      const data = treasury.interface.encodeFunctionData("unpause");
      const idx = await submitTx(owner0, await treasury.getAddress(), 0n, data);
      await confirmBy(idx, owner0, owner1, owner2);
      await expect(treasury.connect(owner0).executeTransaction(idx)).to.be.revertedWith("tx failed");
      expect(await treasury.paused()).to.equal(false);
    });

    it("keeps pause and freeze independent, with freeze taking precedence", async () => {
      await pauseTreasury();

      // Escalating from paused to frozen stays possible.
      const freezeData = treasury.interface.encodeFunctionData("emergencyFreeze");
      const freezeIdx = await submitTx(owner0, await treasury.getAddress(), 0n, freezeData);
      await confirmBy(freezeIdx, owner0, owner1, owner2);
      await treasury.connect(owner0).executeTransaction(freezeIdx);
      expect(await treasury.frozen()).to.equal(true);
      expect(await treasury.paused()).to.equal(true);

      // A freeze closes even the emergency withdrawal hatch.
      const withdrawData = treasury.interface.encodeFunctionData("emergencyWithdraw", [
        recipient.address,
        ethers.parseEther("1"),
      ]);
      const withdrawIdx = await submitTx(owner0, await treasury.getAddress(), 0n, withdrawData);
      await expect(treasury.connect(owner0).confirmTransaction(withdrawIdx)).to.be.revertedWith(
        "frozen"
      );
    });
  });
});
