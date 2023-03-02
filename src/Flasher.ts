import {Contract, Wallet, Transaction} from "ethers";
import * as _ from "lodash";
import {
    FlashbotsBundleProvider,
    RelayResponseError, SimulationResponse,
    SimulationResponseSuccess,
    FlashbotsBundleResolution,
    TransactionSimulationRevert, FlashbotsTransactionResponse
} from "@flashbots/ethers-provider-bundle";

import { bigNumberToDecimal, log } from "./utils";

let submitted = 0;

export class Flasher {
  private flashbotsProvider: FlashbotsBundleProvider;
  private bundleExecutorContract: Contract;
  private executorWallet: Wallet;
  private sentCount: number;

  constructor(executorWallet: Wallet, flashbotsProvider: FlashbotsBundleProvider, bundleExecutorContract: Contract) {
    this.executorWallet = executorWallet;
    this.flashbotsProvider = flashbotsProvider;
    this.bundleExecutorContract = bundleExecutorContract;
    this.sentCount = 0;
  }

  async executeOrder(blockNumber: number, buyTx: Transaction, signedTransaction: string, txHash: string, sellTx: Transaction, baseString: string): Promise<boolean> {
      const bundledTransactions = [
          {
              signer: this.executorWallet,
              transaction: buyTx
          },
          {
              signedTransaction: signedTransaction
          },
          {
            signer: this.executorWallet,
            transaction: sellTx
          },
      ];

      const signedBundle = await this.flashbotsProvider.signBundle(bundledTransactions)

      const simulation = await this.flashbotsProvider.simulate(signedBundle, blockNumber + 1 )

      if ("error" in simulation || simulation.firstRevert !== undefined) {
        const txSimRes = ((simulation as SimulationResponseSuccess).firstRevert as TransactionSimulationRevert);
        if(simulation && !txSimRes) log(`${txHash} Simulation Error on tx, skipping` + (simulation as RelayResponseError).error.message + JSON.stringify(simulation), false);

        if(txSimRes) { // @ts-ignore
            log(`${txHash} Simulation Error on tx, skipping, from: ` + txSimRes.fromAddress + ' ,  ' + txSimRes.revert, false);
        }
        return true;
      }
      log(`${txHash}, ${blockNumber} -> Submitting bundle, profit sent to miner: ${bigNumberToDecimal(simulation.coinbaseDiff)}, effective gas price: ${bigNumberToDecimal(simulation.coinbaseDiff.div(simulation.totalGasUsed), 9)} GWEI`, true)
      const effectiveGasPrice = bigNumberToDecimal(simulation.coinbaseDiff.div(simulation.totalGasUsed), 9);
      log(baseString, true);

      const bundlePromises =  _.map([blockNumber + 1], targetBlockNumber =>
        this.flashbotsProvider.sendRawBundle(
          signedBundle,
          targetBlockNumber
        ))
      const bundleSubmissions = await Promise.all(bundlePromises)

      submitted++;

      bundleSubmissions.forEach(async bundleSubmission => {
          if ('error' in bundleSubmission) {
              log('Error' + bundleSubmission, true);
          }
          const waitResponse = await ((bundleSubmission as FlashbotsTransactionResponse).wait());
          const bundleSubmissionSimulation = await  ((bundleSubmission as FlashbotsTransactionResponse).simulate());
          log(JSON.stringify({ bundleSubmissionSimulation, waitResponse: FlashbotsBundleResolution[waitResponse] }), true)
      });

      return true;

    }
}

// const bundleSubmission = await this.flashbotsProvider.sendRawBundle(
//     signedBundle,
//     blockNumber + 1)
