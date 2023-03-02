import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import fs from 'fs';
import {Contract, providers, Wallet, utils, BigNumber, ethers} from "ethers";
import { ConnectionInfo } from 'ethers/lib/utils'
import { UNISWAP_ROUTER_ABI, UNISWAP_SELL_EXECUTOR_ABI, ERC20_ABI, FACTORY_ABI, LP_TOKEN_ABI } from "./abi";
import { Flasher } from "./Flasher";
import {ETHER, getDefaultRelaySigningKey, getAmountIn, getAmountOut, log} from "./utils";
import {TEST_VOLUMES_REVERSED} from "./constants";

const PRIVATE_KEY = process.env.PRIVATE_KEY || ""
const BUNDLE_EXECUTOR_ADDRESS = '';
const FLASHBOTS_RELAY_SIGNING_KEY = process.env.FLASHBOTS_RELAY_SIGNING_KEY || getDefaultRelaySigningKey();
const routerAddress = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const sushiRouterAddress = '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f';
const wEthAddress = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const factoryAddress = '';
const flasherAddress = ''

const provider = new providers.WebSocketProvider('ws://localhost:3334');

const arbitrageSigningWallet = new Wallet(PRIVATE_KEY).connect(provider);
const flashbotsRelaySigningWallet = new Wallet(FLASHBOTS_RELAY_SIGNING_KEY);
const iface = new utils.Interface(UNISWAP_ROUTER_ABI);
const ifaceExecutor = new utils.Interface(UNISWAP_SELL_EXECUTOR_ABI);
const factoryContract = new Contract(factoryAddress, FACTORY_ABI, provider);
const routerContract = new Contract(routerAddress, UNISWAP_ROUTER_ABI, provider);
const sushiRouterContract = new Contract(sushiRouterAddress, UNISWAP_ROUTER_ABI, provider);

const pricePerDesruction = ethers.utils.parseEther('0.0008');

let currentBlockNumber = 0;
let toRetry: string[] = [];

const getBalance = async () => {
  const contract = new Contract(wEthAddress, ERC20_ABI, provider);
  const balance = await contract.balanceOf(BUNDLE_EXECUTOR_ADDRESS);
  return balance;
};

const getBalanceToken = async (token : string, address : string) => {
  const contract = new Contract(token, ERC20_ABI, provider);
  const balance = await contract.balanceOf(address);
  return balance;
};

const init = async function () {
  const flashbotsProvider = await FlashbotsBundleProvider.create(provider, flashbotsRelaySigningWallet);
  const flasher = new Flasher(
      arbitrageSigningWallet,
      flashbotsProvider,
      new Contract(BUNDLE_EXECUTOR_ADDRESS, UNISWAP_SELL_EXECUTOR_ABI, provider) )

  const startingWEthBalance = await getBalance();
  const startingFlasherBalance = await provider.getBalance(flasherAddress);
  const totalStartingBalance = startingWEthBalance.add(startingFlasherBalance);

  log('Starting balance: ' + totalStartingBalance.div(('1000000000000000')).toNumber() / 1000, true);

  // const launchNonce = (await provider.getTransactionCount(arbitrageSigningWallet.address)) + 20;

  const execute = function (txHash : string) {
    provider.getTransaction(txHash).then(async function (transaction) {
      if(!transaction) {
        // log('no tx: ' + txHash);
        return;
      }
      if(transaction.to === routerAddress || transaction.to === sushiRouterAddress)  {
        if(transaction.blockNumber) {
          const index = toRetry.indexOf(txHash);
          toRetry[index] = '';
          log(txHash + ' already mined', true)
          return;
        }

        try {

          // --------------- PARSE  TX
          let decodedParams;
          let token;
          let amountOutMin;
          let amountIn;
          let tokenFrom;
          let isAmountOutMin = false;
          try {
            decodedParams = iface.decodeFunctionData("swapExactTokensForTokens", transaction.data)
            token = decodedParams.path[decodedParams.path.length - 1].toLowerCase();
            tokenFrom = decodedParams.path[decodedParams.path.length - 2].toLowerCase();
            amountIn = decodedParams.amountIn;
            amountOutMin = decodedParams.amountOutMin;
            isAmountOutMin = true;
          } catch (e) {
            try {
              decodedParams = iface.decodeFunctionData("swapTokensForExactTokens", transaction.data)
              token = decodedParams.path[decodedParams.path.length - 1].toLowerCase();
              tokenFrom = decodedParams.path[decodedParams.path.length - 2].toLowerCase();
              amountIn = decodedParams.amountInMax;
              amountOutMin = decodedParams.amountOut;
            } catch (e) {
              try {
                decodedParams = iface.decodeFunctionData("swapETHForExactTokens", transaction.data)
                token = decodedParams.path[decodedParams.path.length - 1].toLowerCase();
                tokenFrom = wEthAddress;
                amountIn = transaction.value;
                amountOutMin = decodedParams.amountOut;
              } catch (e) {
                decodedParams = iface.decodeFunctionData("swapExactETHForTokens", transaction.data)
                token = decodedParams.path[decodedParams.path.length - 1].toLowerCase();
                tokenFrom = wEthAddress;
                amountIn = transaction.value;
                amountOutMin = decodedParams.amountOutMin;
                isAmountOutMin = true;
              }
            }
          }

          if(decodedParams.path.length > 3) {
            log(txHash + ' skipping1' + JSON.stringify(decodedParams), false)
            return;
          }
          if(tokenFrom !== wEthAddress) {
            log(txHash + ' skipping2' + JSON.stringify(decodedParams), false)
            return;
          }

          // --------------- PLAY WITH AMOUNT TO BUY
          const lpTokenAddress = await factoryContract.getPair(wEthAddress, token);

          const lpTokenContract = new Contract(lpTokenAddress, LP_TOKEN_ABI, provider);
          const token0Address = (await lpTokenContract.token0()).toLowerCase();
          const [reserve0, reserve1] = await lpTokenContract.getReserves();
          let reserveWEth, reserveToken;

          if(token0Address == wEthAddress) {
            reserveWEth = reserve0;
            reserveToken = reserve1;
          } else {
            reserveWEth = reserve1;
            reserveToken = reserve0;
          }


          // const reserveWEth  = await getBalanceToken(wEthAddress, lpTokenAddress);
          // const reserveToken = await getBalanceToken(token, lpTokenAddress);

          const balanceWEth  = await getBalanceToken(wEthAddress, lpTokenAddress);
          const balanceToken = await getBalanceToken(token, lpTokenAddress);
          //
          // if(!balanceWEth.eq(reserveWEth) || !balanceToken.eq(reserveToken)) {
          //   console.log({
          //     reserveWEth: reserveWEth.toString(),
          //     reserveToken: reserveToken.toString(),
          //     balanceWEth: balanceWEth.toString(),
          //     balanceToken: balanceToken.toString(),
          //   })
          //   return;
          // }

          log(JSON.stringify({
            txHash: transaction.hash,
            reserveWEth: reserveWEth.toString(),
            reserveToken: reserveToken.toString(),
            balanceWEth: balanceWEth.toString(),
            balanceToken: balanceToken.toString(),
            timeNow: new Date(),
            block: currentBlockNumber
            // eslint-disable-next-line @typescript-eslint/no-empty-function
          })+ '\n',false);

          if(decodedParams.path.length === 3 && tokenFrom === wEthAddress) {
            let amountsOut;
            if(transaction.to == sushiRouterAddress) {
              amountsOut = await sushiRouterContract.getAmountsOut(amountIn,  decodedParams.path);
            } else {
              amountsOut = await routerContract.getAmountsOut(amountIn,  decodedParams.path);
            }
            const newAmountIn = amountsOut[1];
            amountIn = newAmountIn;
          }

          // ------- GET the token

          const targetEthIn = amountIn;
          let closestEthPrice = BigNumber.from(0);
          let closestEthSize = BigNumber.from(0);
          let closestTokenSize = BigNumber.from(0);
          let closestReserveWEth = BigNumber.from(0);
          let closestReserveToken = BigNumber.from(0);

          for (const size of TEST_VOLUMES_REVERSED) {
            const testAmountOut = getAmountOut(reserveWEth, reserveToken, size)
            const updatedReserveWEth = reserveWEth.add(size);
            const updatedReserveToken = reserveToken.sub(testAmountOut)
            const ethIn = getAmountIn(updatedReserveWEth, updatedReserveToken, amountOutMin)
            const isTargetEthInAbove = targetEthIn.gt(ethIn);
            const isCurrentHigherThanLatest = ethIn.gt(closestEthPrice)
            if(isTargetEthInAbove && isCurrentHigherThanLatest) {
              closestEthPrice = ethIn;
              closestEthSize = size;
              closestTokenSize = testAmountOut;
              closestReserveToken = updatedReserveToken;
              closestReserveWEth = updatedReserveWEth;
              // eslint-disable-next-line @typescript-eslint/no-empty-function
              log(JSON.stringify({
                txHash: transaction.hash,
                targetEthIn: targetEthIn.div(('1000000000000000')).toNumber() / 1000,
                ethIn: ethIn.div(('1000000000000000')).toNumber() / 1000,
                size: size.div(('1000000000000000')).toNumber() / 1000,
                isTargetEthInAbove: targetEthIn.gt(ethIn),
                reserveWEth: reserveWEth.toString(),
                reserveToken: reserveToken.toString(),
                updatedReserveWEth: reserveWEth.toString(),
                updatedReserveToken: reserveToken.toString(),
                testAmountOut: testAmountOut.toString(),
                timeNow: new Date(),
                block: currentBlockNumber
                // eslint-disable-next-line @typescript-eslint/no-empty-function
              })+ '\n',false);
              break;
            }
          }

          let newClosestEthPrice = BigNumber.from(0);
          let newClosestEthSize = BigNumber.from(0);
          let newClosestTokenSize = BigNumber.from(0);
          let newClosestReserveWEth = BigNumber.from(0);
          let newClosestReserveToken = BigNumber.from(0);

          // if(closestEthPrice.eq(0))  {
          //   log(txHash + ' skipping3', false)
          //   return;
          // }
          if(closestEthPrice.eq(0) || ethers.utils.parseEther("4.0").lte(closestEthSize))  {
            if(toRetry.indexOf(transaction.hash) === -1) {
              toRetry.unshift(transaction.hash);
            }
            return;
          }

          while (newClosestEthPrice.lte(targetEthIn)) {
            const newTestSize = closestEthSize.add(ETHER.div(1000));
            closestEthSize = newTestSize;
            const testAmountOut = getAmountOut(reserveWEth, reserveToken, newTestSize)
            const updatedReserveWEth = reserveWEth.add(newTestSize);
            const updatedReserveToken = reserveToken.sub(testAmountOut)
            const ethIn = getAmountIn(updatedReserveWEth, updatedReserveToken, amountOutMin)
            const isTargetEthInAbove = targetEthIn.gt(ethIn);
            const isCurrentHigherThanLatest = ethIn.gte(newClosestEthPrice)
            if(isTargetEthInAbove && isCurrentHigherThanLatest) {
              newClosestEthPrice = ethIn;
              newClosestEthSize = newTestSize;
              newClosestTokenSize = testAmountOut;
              newClosestReserveToken = updatedReserveToken;
              newClosestReserveWEth = updatedReserveWEth;
            } else {
              if (closestEthPrice.eq(0)) {
                newClosestEthPrice = closestEthPrice;
                newClosestEthSize = closestEthSize;
                newClosestTokenSize = closestTokenSize;
                newClosestReserveToken = updatedReserveToken;
                newClosestReserveWEth = updatedReserveWEth;
                log(JSON.stringify({
                  txHash: transaction.hash,
                  newClosestEthSize: newClosestEthSize.div(('1000000000000000')).toNumber() / 1000,
                  timeNow: new Date(),
                  reserveWEth: reserveWEth.toString(),
                  reserveToken: reserveToken.toString(),
                  updatedReserveWEth: reserveWEth.toString(),
                  updatedReserveToken: reserveToken.toString(),
                  testAmountOut: testAmountOut.toString(),
                  block: currentBlockNumber
                  // eslint-disable-next-line @typescript-eslint/no-empty-function
                }) +  '\n', false);
              }

              break;
            }
          }

          // amountInput = balanceAfterTransfer.sub(reserveInput);
          // amountOutput = UniswapV2Library.getAmountOut(amountInput, reserveInput, reserveOutput);

          // Amounts for BUY trade
          const amountBuyInput = newClosestEthSize; // balanceWEth.add(newClosestEthSize).sub(reserveWEth);
          const amountBuyOutput = getAmountOut(reserveWEth, reserveToken, amountBuyInput);
          const reserveWEthAfterBuy = reserveWEth.add(amountBuyInput);
          const reserveTokenAfterBuy = reserveToken.sub(amountBuyOutput);

          // Amounts for user trade
          let amountUserInput;
          let amountUserOutput;
          if(isAmountOutMin) {
            amountUserInput = targetEthIn;
            amountUserOutput = getAmountOut(reserveWEthAfterBuy, reserveTokenAfterBuy, amountUserInput);
          } else {
            amountUserOutput = amountOutMin;
            amountUserInput = getAmountIn(reserveWEthAfterBuy, reserveTokenAfterBuy, amountUserOutput);
          }

          const reserveWEthAfterUser = reserveWEthAfterBuy.add(amountUserInput);
          const reserveTokenAfterUser = reserveTokenAfterBuy.sub(amountUserOutput);

          // Amounts for SELL trade
          const amountSellInput = amountBuyOutput.sub(1);
          const amountSellOutput = getAmountOut(reserveTokenAfterUser, reserveWEthAfterUser, amountSellInput);


          // ------ CALCULATE WETH OUT
          const wEthBalance = await getBalance();
          const randomisedPercentage = 93; // Math.floor(Math.random() * (93 - 91) + 91);
          const profit = amountSellOutput.sub(amountBuyInput);
          const minerProfit = profit.mul(randomisedPercentage).div(100);
          const myProfit = profit.sub(minerProfit);

          const basesString = JSON.stringify({
            txHash: transaction.hash,
            randomisedPercentage: randomisedPercentage,
            wEthOut: amountSellOutput.div(('100000000000000')).toNumber() / 10000,
            profit: profit.div(('100000000000000')).toNumber() / 10000,
            minerProfit: minerProfit.div(('100000000000000')).toNumber() / 10000,
            timeNow: new Date(),
          });
          log(basesString, true);

          if(minerProfit.lt(ethers.utils.parseEther("0.0001"))) {
            if(toRetry.indexOf(transaction.hash) === -1) {
              toRetry.unshift(transaction.hash);
            }
            return;
          }

          if(minerProfit.gt(ethers.utils.parseEther("0.3"))) {
            if(toRetry.indexOf(transaction.hash) === -1) {
              toRetry.unshift(transaction.hash);
            }
            return;
          }

          let toDestructBuy = 0;
          let toDestructSell = 0;

          if(myProfit.gt(pricePerDesruction.mul(1).add(ethers.utils.parseEther('0.0006')))) {
            toDestructBuy = 0;
            toDestructSell = 1;
          }
          if(myProfit.gt(pricePerDesruction.mul(2).add(ethers.utils.parseEther('0.0006')))) {
            toDestructBuy = 1;
            toDestructSell = 1;
          }
          if(myProfit.gt(pricePerDesruction.mul(3).add(ethers.utils.parseEther('0.0006')))) {
            toDestructBuy = 1;
            toDestructSell = 2;
          }
          if(myProfit.gt(pricePerDesruction.mul(4).add(ethers.utils.parseEther('0.0006')))) {
            toDestructBuy = 2;
            toDestructSell = 2;
          }
          if(myProfit.gt(pricePerDesruction.mul(5).add(ethers.utils.parseEther('0.0006')))) {
            toDestructBuy = 2;
            toDestructSell = 3;
          }
          if(myProfit.gt(pricePerDesruction.mul(6).add(ethers.utils.parseEther('0.0006')))) {
            toDestructBuy = 3;
            toDestructSell = 3;
          }
          if(myProfit.gt(pricePerDesruction.mul(7).add(ethers.utils.parseEther('0.0006')))) {
            toDestructBuy = 3;
            toDestructSell = 4;
          }
          if(myProfit.gt(pricePerDesruction.mul(8).add(ethers.utils.parseEther('0.0006')))) {
            toDestructBuy = 4;
            toDestructSell = 4;
          }
          if(myProfit.gt(pricePerDesruction.mul(9).add(ethers.utils.parseEther('0.0006')))) {
            toDestructBuy = 4;
            toDestructSell = 5;
          }
          if(myProfit.gt(pricePerDesruction.mul(10).add(ethers.utils.parseEther('0.0006')))) {
            toDestructBuy = 5;
            toDestructSell = 5;
          }

          log(txHash + ' toDestruct' + (toDestructSell + toDestructBuy), true);

          // --------------- VERIFY IF TOKEN is legit?
          let shouldBuy = false;

          if (reserveWEth.gt(ethers.utils.parseEther("10"))) shouldBuy = true;

          if(shouldBuy && newClosestEthSize.lt(ethers.utils.parseEther("0.001")))  {
            log(txHash + ' skipping6', false)
            return;
          }

          // ---------------  SERIALIZE
          if(shouldBuy)  {
            try {
              // console.log(transaction.hash);
              const serialisedTransaction = utils.serializeTransaction({
                to: transaction.to,
                nonce: transaction.nonce,
                gasLimit: transaction.gasLimit,
                gasPrice: transaction.gasPrice,
                data: transaction.data,
                value: transaction.value,
                chainId: transaction.chainId}, {
                r: transaction.r || "",
                s: transaction.s || "",
                v: transaction.v || undefined,
              })
              // console.log('ETH invested', amountInEth);

              const date = new Date();
              date.setHours(date.getHours() + 1);


              // function sB(address _pairAddress, uint256 amount0Out, uint256 amount1Out, uint256 amountIn, uint256 toDestruct)
              const buySwapData = ifaceExecutor.encodeFunctionData('sB', [lpTokenAddress, token0Address === wEthAddress ? 0 : amountBuyOutput, token0Address === wEthAddress ? amountBuyOutput : 0, amountBuyInput, toDestructBuy]);
              const txCount = await provider.getTransactionCount(arbitrageSigningWallet.address);

              // if(txCount > launchNonce) {
              //   log(txHash + ' skipping7', false)
              //   return;
              // }

              const buyTx = {
                to: BUNDLE_EXECUTOR_ADDRESS,
                value: ethers.utils.parseEther("0"),
                gasLimit: BigNumber.from(12000000),
                gasPrice: ethers.utils.parseUnits("0", "gwei"),
                nonce: txCount,
                data: buySwapData,
                chainId: 1,
              }

              // function sS(address _pairAddress, address _tokenAddress, uint256 amount0Out, uint256 amount1Out, uint256 amountIn, uint256 destruct) external onlyExecutor payable
              const sellSwapData = ifaceExecutor.encodeFunctionData('sS', [lpTokenAddress, token, token0Address === wEthAddress ? amountSellOutput : 0, token0Address === wEthAddress ? 0 : amountSellOutput, amountSellInput, toDestructSell]);

              const sellTx = {
                to: BUNDLE_EXECUTOR_ADDRESS,
                value: minerProfit,
                gasLimit: BigNumber.from(12000000),
                gasPrice: ethers.utils.parseUnits("0", "gwei"),
                nonce: txCount + 1,
                data: sellSwapData,
                chainId: 1,
              }

              const baseString = JSON.stringify({
                txHash: transaction.hash,
                targetEthIn: targetEthIn.div(('1000000000000000')).toNumber() / 1000,
                newClosestEthSize: newClosestEthSize.div(('1000000000000000')).toNumber() / 1000,
                newClosestEthPrice: newClosestEthPrice.div(('1000000000000000')).toNumber() / 1000,
                timeNow: new Date(),
              });
              log(baseString, true);

              if(wEthBalance.lt(closestEthSize)) {
                if(toRetry.indexOf(transaction.hash) === -1) {
                  toRetry.unshift(transaction.hash);
                }
                return;
              }

              const toRetryTx = await flasher.executeOrder(currentBlockNumber, buyTx, serialisedTransaction, transaction.hash, sellTx, baseString);
              if(toRetryTx && toRetry.indexOf(transaction.hash) === -1) {
                toRetry.unshift(transaction.hash);
              }
            } catch (e) {
              log(txHash + ' error' + JSON.stringify(e), false)
            }
          }
        } catch (e) {
          log(txHash + ' error' + JSON.stringify(e), false)
        }
      } else {
        log(txHash + ' not processing as tx is not going to router', false)
      }
    });
  }

  provider.on("block", async (block) => {
    if(toRetry.length > 300) toRetry = toRetry.slice(0, 200);
    currentBlockNumber = block;
    log((new Date() + ' ' +block + ' Retrying: ' + toRetry), true);
    toRetry.filter(t => t !== '').forEach(t => execute(t));
    const wethBalance = await getBalance();
    const flasherBalance = await provider.getBalance(flasherAddress);
    const totalBalance = wethBalance.add(flasherBalance);
    const profit = totalBalance.sub(totalStartingBalance);

    log('Balance: ' + totalBalance.div(('1000000000000000')).toNumber() / 1000 + ', profit: ' + profit.div(('1000000000000000')).toNumber() / 1000, true);
  });

  provider.on("pending", (tx) => {
    execute(tx);
    log(tx + ' ' + new Date() + ' ' +currentBlockNumber);
  });

  provider._websocket.on("error", async () => {
    console.log(`Unable to connect to} retrying in 3s...`);
    setTimeout(init, 3000);
  });
  provider._websocket.on("close", async (code : string) => {
    console.log(
        `Connection lost with code ${code}! Attempting reconnect in 3s...`
    );
    provider._websocket.terminate();
    setTimeout(init, 3000);
  });
};

init();
