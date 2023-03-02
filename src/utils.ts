import { BigNumber, Wallet } from "ethers";
import fs from "fs";

export const ETHER = BigNumber.from(10).pow(18);

export function bigNumberToDecimal(value: BigNumber, base = 18): number {
  const divisor = BigNumber.from(10).pow(base)
  return value.mul(10000).div(divisor).toNumber() / 10000
}

export function getDefaultRelaySigningKey(): string {
  console.warn("You have not specified an explicity FLASHBOTS_RELAY_SIGNING_KEY environment variable. Creating random signing key, this searcher will not be building a reputation for next run")
  return Wallet.createRandom().privateKey;
}

export function getAmountIn(reserveIn: BigNumber, reserveOut: BigNumber, amountOut: BigNumber) {
  const numerator = reserveIn.mul(amountOut).mul(1000);
  const denominator = reserveOut.sub(amountOut).mul(997);
  return numerator.div(denominator).add(1);
}

export function getAmountOut(reserveIn: BigNumber, reserveOut: BigNumber, amountIn: BigNumber) {
  const amountInWithFee = amountIn.mul(997);
  const numerator = amountInWithFee.mul(reserveOut);
  const denominator = reserveIn.mul(1000).add(amountInWithFee);
  return numerator.div(denominator);
}

export function log(str: string, toConsole?: boolean) {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  fs.appendFile('txs.txt', str+ '\n', (e)=> {});
  if(toConsole) console.log(str);
}
