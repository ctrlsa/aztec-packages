import { getUnsafeSchnorrAccount, getUnsafeSchnorrWallet } from '@aztec/accounts/single_key';
import {
  type AccountWallet,
  type ContractInstanceWithAddress,
  ExtendedNote,
  Note,
  type TxHash,
  computeSecretHash,
} from '@aztec/aztec.js';
import { type Salt } from '@aztec/aztec.js/account';
import { type AztecAddress, type CompleteAddress, Fr, deriveSigningKey } from '@aztec/circuits.js';
import { type DeployL1Contracts } from '@aztec/ethereum';
// We use TokenBlacklist because we want to test the persistence of manually added notes and standard token no longer
// implements TransparentNote shield flow.
import { TokenBlacklistContract } from '@aztec/noir-contracts.js/TokenBlacklist';

import { jest } from '@jest/globals';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { BlacklistTokenContractTest, Role } from '../e2e_blacklist_token_contract/blacklist_token_contract_test.js';
import { type EndToEndContext, setup } from '../fixtures/utils.js';

jest.setTimeout(60_000);

describe('Aztec persistence', () => {
  /**
   * These tests check that the Aztec Node and PXE can be shutdown and restarted without losing data.
   *
   * There are five scenarios to check:
   * 1. Node and PXE are started with an existing databases
   * 2. PXE is started with an existing database and connects to a Node with an empty database
   * 3. PXE is started with an empty database and connects to a Node with an existing database
   * 4. PXE is started with an empty database and connects to a Node with an empty database
   * 5. Node and PXE are started with existing databases, but the chain has advanced since they were shutdown
   *
   * All five scenarios use the same L1 state, which is deployed in the `beforeAll` hook.
   */

  // the test contract and account deploying it
  let contractInstance: ContractInstanceWithAddress;
  let contractAddress: AztecAddress;
  let ownerSecretKey: Fr;
  let ownerAddress: CompleteAddress;
  let ownerSalt: Salt;

  // a directory where data will be persisted by components
  // passing this through to the Node or PXE will control whether they use persisted data or not
  let dataDirectory: string;

  // state that is persisted between tests
  let deployL1ContractsValues: DeployL1Contracts;

  let context: EndToEndContext;

  // deploy L1 contracts, start initial node & PXE, deploy test contract & shutdown node and PXE
  beforeAll(async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'aztec-node-'));

    const initialContext = await setup(0, { dataDirectory }, { dataDirectory });
    deployL1ContractsValues = initialContext.deployL1ContractsValues;

    ownerSecretKey = Fr.random();
    const ownerAccount = await getUnsafeSchnorrAccount(initialContext.pxe, ownerSecretKey, Fr.ZERO);
    const ownerWallet = await ownerAccount.waitSetup();
    ownerAddress = ownerWallet.getCompleteAddress();
    ownerSalt = ownerWallet.salt;

    const contract = await TokenBlacklistContract.deploy(ownerWallet, ownerWallet.getAddress()).send().deployed();
    contractInstance = contract.instance;
    contractAddress = contract.address;

    await progressBlocksPastDelay(contract);

    const adminMinterRole = new Role().withAdmin().withMinter();
    await contract.methods.update_roles(ownerWallet.getAddress(), adminMinterRole.toNoirStruct()).send().wait();

    await progressBlocksPastDelay(contract);

    const secret = Fr.random();

    const mintTxReceipt = await contract.methods
      .mint_private(1000n, await computeSecretHash(secret))
      .send()
      .wait();

    await addPendingShieldNoteToPXE(
      ownerWallet,
      contractAddress,
      1000n,
      await computeSecretHash(secret),
      mintTxReceipt.txHash,
    );

    await contract.methods.redeem_shield(ownerAddress.address, 1000n, secret).send().wait();

    await progressBlocksPastDelay(contract);

    await initialContext.teardown();
  }, 180_000);

  const progressBlocksPastDelay = async (contract: TokenBlacklistContract) => {
    for (let i = 0; i < BlacklistTokenContractTest.DELAY; ++i) {
      await contract.methods.get_roles(ownerAddress.address).send().wait();
    }
  };

  describe.each([
    [
      // ie we were shutdown and now starting back up. Initial sync should be ~instant
      'when starting Node and PXE with existing databases',
      () => setup(0, { dataDirectory, deployL1ContractsValues }, { dataDirectory }),
      1000,
    ],
    [
      // ie our PXE was restarted, data kept intact and now connects to a "new" Node. Initial synch will synch from scratch
      'when starting a PXE with an existing database, connected to a Node with database synched from scratch',
      () => setup(0, { deployL1ContractsValues }, { dataDirectory }),
      10_000,
    ],
  ])('%s', (_, contextSetup, timeout) => {
    let ownerWallet: AccountWallet;
    let contract: TokenBlacklistContract;

    beforeEach(async () => {
      context = await contextSetup();
      const signingKey = deriveSigningKey(ownerSecretKey);
      ownerWallet = await getUnsafeSchnorrWallet(context.pxe, ownerAddress.address, signingKey);
      contract = await TokenBlacklistContract.at(contractAddress, ownerWallet);
    }, timeout);

    afterEach(async () => {
      await context.teardown();
    });

    it('correctly restores private notes', async () => {
      // test for >0 instead of exact value so test isn't dependent on run order
      await expect(contract.methods.balance_of_private(ownerWallet.getAddress()).simulate()).resolves.toBeGreaterThan(
        0n,
      );
    });

    it('correctly restores public storage', async () => {
      await expect(contract.methods.total_supply().simulate()).resolves.toBeGreaterThan(0n);
    });

    it('tracks new notes for the owner', async () => {
      const balance = await contract.methods.balance_of_private(ownerWallet.getAddress()).simulate();

      const secret = Fr.random();
      const mintTxReceipt = await contract.methods
        .mint_private(1000n, await computeSecretHash(secret))
        .send()
        .wait();
      await addPendingShieldNoteToPXE(
        ownerWallet,
        contractAddress,
        1000n,
        await computeSecretHash(secret),
        mintTxReceipt.txHash,
      );

      await contract.methods.redeem_shield(ownerWallet.getAddress(), 1000n, secret).send().wait();

      await expect(contract.methods.balance_of_private(ownerWallet.getAddress()).simulate()).resolves.toEqual(
        balance + 1000n,
      );
    });

    it('allows spending of private notes', async () => {
      const otherAccount = await getUnsafeSchnorrAccount(context.pxe, Fr.random(), Fr.ZERO);
      const otherWallet = await otherAccount.waitSetup();

      const initialOwnerBalance = await contract.methods.balance_of_private(ownerWallet.getAddress()).simulate();

      await contract.methods.transfer(ownerWallet.getAddress(), otherWallet.getAddress(), 500n, 0).send().wait();

      const [ownerBalance, targetBalance] = await Promise.all([
        contract.methods.balance_of_private(ownerWallet.getAddress()).simulate(),
        contract.methods.balance_of_private(otherWallet.getAddress()).simulate(),
      ]);

      expect(ownerBalance).toEqual(initialOwnerBalance - 500n);
      expect(targetBalance).toEqual(500n);
    });
  });

  describe.each([
    [
      // ie. I'm setting up a new full node, sync from scratch and restore wallets/notes
      'when starting the Node and PXE with empty databases',
      () => setup(0, { deployL1ContractsValues }, {}),
      10_000,
    ],
    [
      // ie. I'm setting up a new PXE, restore wallets/notes from a Node
      'when starting a PXE with an empty database connected to a Node with an existing database',
      () => setup(0, { dataDirectory, deployL1ContractsValues }, {}),
      10_000,
    ],
  ])('%s', (_, contextSetup, timeout) => {
    beforeEach(async () => {
      context = await contextSetup();
    }, timeout);
    afterEach(async () => {
      await context.teardown();
    });

    it('the node has the contract', async () => {
      await expect(context.aztecNode.getContract(contractAddress)).resolves.toBeDefined();
    });

    it('pxe does not know of the deployed contract', async () => {
      const account = await getUnsafeSchnorrAccount(context.pxe, Fr.random(), Fr.ZERO);
      const wallet = await account.waitSetup();
      await expect(TokenBlacklistContract.at(contractAddress, wallet)).rejects.toThrow(/has not been registered/);
    });

    it("pxe does not have owner's private notes", async () => {
      await context.pxe.registerContract({
        artifact: TokenBlacklistContract.artifact,
        instance: contractInstance,
      });

      const account = await getUnsafeSchnorrAccount(context.pxe, Fr.random(), Fr.ZERO);
      const wallet = await account.waitSetup();
      const contract = await TokenBlacklistContract.at(contractAddress, wallet);
      await expect(contract.methods.balance_of_private(ownerAddress.address).simulate()).resolves.toEqual(0n);
    });

    it('has access to public storage', async () => {
      await context.pxe.registerContract({
        artifact: TokenBlacklistContract.artifact,
        instance: contractInstance,
      });

      const account = await getUnsafeSchnorrAccount(context.pxe, Fr.random(), Fr.ZERO);
      const wallet = await account.waitSetup();
      const contract = await TokenBlacklistContract.at(contractAddress, wallet);

      await expect(contract.methods.total_supply().simulate()).resolves.toBeGreaterThan(0n);
    });

    it('pxe restores notes after registering the owner', async () => {
      await context.pxe.registerContract({
        artifact: TokenBlacklistContract.artifact,
        instance: contractInstance,
      });

      const ownerAccount = await getUnsafeSchnorrAccount(context.pxe, ownerSecretKey, ownerSalt);
      await ownerAccount.register();
      const ownerWallet = await ownerAccount.getWallet();
      const contract = await TokenBlacklistContract.at(contractAddress, ownerWallet);

      // check that notes total more than 0 so that this test isn't dependent on run order
      await expect(contract.methods.balance_of_private(ownerAddress.address).simulate()).resolves.toBeGreaterThan(0n);
    });
  });

  describe('when starting Node and PXE with existing databases, but chain has advanced since they were shutdown', () => {
    let secret: Fr;
    let mintTxHash: TxHash;
    let mintAmount: bigint;
    let revealedAmount: bigint;

    // The test system is shutdown. Its state is saved to disk
    // Start a temporary node and PXE, synch it and add the contract and account to it.
    // Perform some actions with these temporary components to advance the chain
    // Then shutdown the temporary components and restart the original components
    // They should sync up from where they left off and be able to see the actions performed by the temporary node & PXE.
    beforeAll(async () => {
      const temporaryContext = await setup(0, { deployL1ContractsValues }, {});

      await temporaryContext.pxe.registerContract({
        artifact: TokenBlacklistContract.artifact,
        instance: contractInstance,
      });

      const ownerAccount = await getUnsafeSchnorrAccount(temporaryContext.pxe, ownerSecretKey, ownerSalt);
      await ownerAccount.register();
      const ownerWallet = await ownerAccount.getWallet();

      const contract = await TokenBlacklistContract.at(contractAddress, ownerWallet);

      // mint some tokens with a secret we know and redeem later on a separate PXE
      secret = Fr.random();
      mintAmount = 1000n;
      const mintTxReceipt = await contract.methods
        .mint_private(mintAmount, await computeSecretHash(secret))
        .send()
        .wait();
      mintTxHash = mintTxReceipt.txHash;

      // publicly reveal that I have 1000 tokens
      revealedAmount = 1000n;
      await contract.methods.unshield(ownerAddress, ownerAddress, revealedAmount, 0).send().wait();

      // shut everything down
      await temporaryContext.teardown();
    });

    let ownerWallet: AccountWallet;
    let contract: TokenBlacklistContract;

    beforeEach(async () => {
      context = await setup(0, { dataDirectory, deployL1ContractsValues }, { dataDirectory });
      const signingKey = deriveSigningKey(ownerSecretKey);
      ownerWallet = await getUnsafeSchnorrWallet(context.pxe, ownerAddress.address, signingKey);
      contract = await TokenBlacklistContract.at(contractAddress, ownerWallet);
    });

    afterEach(async () => {
      await context.teardown();
    });

    it("restores owner's public balance", async () => {
      await expect(contract.methods.balance_of_public(ownerAddress.address).simulate()).resolves.toEqual(
        revealedAmount,
      );
    });

    it('allows consuming transparent note created on another PXE', async () => {
      // this was created in the temporary PXE in `beforeAll`
      await addPendingShieldNoteToPXE(
        ownerWallet,
        contractAddress,
        mintAmount,
        await computeSecretHash(secret),
        mintTxHash,
      );

      const balanceBeforeRedeem = await contract.methods.balance_of_private(ownerWallet.getAddress()).simulate();

      await contract.methods.redeem_shield(ownerWallet.getAddress(), mintAmount, secret).send().wait();
      const balanceAfterRedeem = await contract.methods.balance_of_private(ownerWallet.getAddress()).simulate();

      expect(balanceAfterRedeem).toEqual(balanceBeforeRedeem + mintAmount);
    });
  });
});

async function addPendingShieldNoteToPXE(
  wallet: AccountWallet,
  asset: AztecAddress,
  amount: bigint,
  secretHash: Fr,
  txHash: TxHash,
) {
  // docs:start:pxe_add_note
  const note = new Note([new Fr(amount), secretHash]);
  const extendedNote = new ExtendedNote(
    note,
    wallet.getAddress(),
    asset,
    TokenBlacklistContract.storage.pending_shields.slot,
    TokenBlacklistContract.notes.TransparentNote.id,
    txHash,
  );
  await wallet.addNote(extendedNote);
  // docs:end:pxe_add_note
}
