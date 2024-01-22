import { ExchangeRouterAbi } from './abi/exchangeRounter';
import { ethers } from 'ethers';
import {
	GmxPositionResponse,
	gmxOrderParams,
	gmxOrderResult
} from '../../types';
import { erc20Abi } from './abi/erc20';
import { getGmxClient } from './client';
import { ReaderAbi } from './abi/reader';
import { BASE_DECIMAL, gmxOrderType } from './constants';
import { _sleep } from '../../helper';

const exchangeRounter = '0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8';
const transferRouter = '0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6';
const reader = '0xf60becbba223eea9495da3f606753867ec10d139';
const dataStore = '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8';

const orderVault = '0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5';
const usdc = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const usdcDecimal = 6;
const myReferralCode =
	'0x74765f616c6572745f636f6e6e6563746f720000000000000000000000000000';

const executionFee = ethers.utils.parseEther('0.0015675');
const signer = getGmxClient();

export const gmxCreateOrder = async (orderParams: gmxOrderParams) => {
	try {
		const gmxContract = new ethers.Contract(
			exchangeRounter,
			ExchangeRouterAbi,
			signer
		);

		const positionResponse = await getOrderTypeAndPosition(
			orderParams.marketAddress,
			orderParams.isLong
		);
		const orderType = positionResponse.orderType;

		let adustedSizeUsd = orderParams.sizeUsd;

		let initialCollateralDeltaAmount = ethers.BigNumber.from(0);
		if (positionResponse.orderType === gmxOrderType.MarketDecrease) {
			let withdrawAmount =
				positionResponse.collateralAmount *
				(orderParams.sizeUsd / positionResponse.positionSizeUsd);
			// when full close
			if (positionResponse.positionSizeUsd < orderParams.sizeUsd) {
				adustedSizeUsd = positionResponse.positionSizeUsd;
				withdrawAmount = positionResponse.collateralAmount;
			}
			withdrawAmount = Math.floor(withdrawAmount * 10000) / 10000;

			initialCollateralDeltaAmount = ethers.utils.parseUnits(
				String(withdrawAmount),
				usdcDecimal
			);
		}

		const decreasePositionSwapType =
			positionResponse.orderType === gmxOrderType.MarketIncrease ? 0 : 1;
		const sizeDeltaUsd = ethers.utils.parseUnits(
			String(adustedSizeUsd),
			BASE_DECIMAL
		);
		const acceptablePrice = getAcceptablePrice(
			orderParams.isLong,
			orderParams.price
		);

		const createOrderParam = {
			addresses: {
				receiver: signer.address,
				callbackContract: '0x0000000000000000000000000000000000000000',
				uiFeeReceiver: '0x0000000000000000000000000000000000000000',
				market: orderParams.marketAddress,
				initialCollateralToken: usdc,
				swapPath: []
			},
			numbers: {
				sizeDeltaUsd,
				initialCollateralDeltaAmount,
				triggerPrice: 0,
				acceptablePrice,
				executionFee,
				callbackGasLimit: 0,
				minOutputAmount: 0
			},
			orderType,
			decreasePositionSwapType,
			isLong: positionResponse.hasLongPosition ?? orderParams.isLong,
			shouldUnwrapNativeToken: false,
			referralCode: myReferralCode
			// 0x0000000000000000000000000000000000000000000000000000000000000000
		};

		console.log('createOrderParam: ', createOrderParam);

		const createOrderData = gmxContract.interface.encodeFunctionData(
			'createOrder',
			[createOrderParam]
		);

		// construct multiCall
		const multiCallParams = [
			gmxContract.interface.encodeFunctionData('sendWnt', [
				orderVault,
				executionFee
			])
		];

		// when MarketIncrease, calculate collateral amount, approve, sentToken
		if (orderType == gmxOrderType.MarketIncrease) {
			let sendCollateralAmount =
				orderParams.sizeUsd / Number(process.env.GMX_LEVERAGE);
			if (sendCollateralAmount < 2) throw Error("Can't send less than 2 USD");
			sendCollateralAmount = Math.ceil(sendCollateralAmount * 100) / 100;
			const parsedSendCollateralAmount = ethers.utils.parseUnits(
				String(sendCollateralAmount),
				usdcDecimal
			);

			await checkAndApprove(parsedSendCollateralAmount);

			multiCallParams.push(
				gmxContract.interface.encodeFunctionData('sendTokens', [
					usdc,
					orderVault,
					parsedSendCollateralAmount
				])
			);
		}

		multiCallParams.push(createOrderData);

		const tx = await gmxContract.multicall(multiCallParams, {
			value: executionFee,
			gasLimit: 20000000
		});
		console.log('Order created successfully:', tx);

		const receipt = await tx.wait();
		console.log('tx receipt', receipt);

		// if it's a decrease order, create another order with rest size
		if (
			orderType == gmxOrderType.MarketDecrease &&
			positionResponse.positionSizeUsd &&
			positionResponse.positionSizeUsd + 2 < orderParams.sizeUsd
		) {
			// wait actual first order is executed
			await _sleep(20000);
			const restSizeUsd =
				orderParams.sizeUsd - positionResponse.positionSizeUsd;

			const restOrderParams: gmxOrderParams = {
				marketAddress: orderParams.marketAddress,
				isLong: orderParams.isLong,
				sizeUsd: Math.round(restSizeUsd * 100) / 100,
				price: orderParams.price
			};
			await gmxCreateOrder(restOrderParams);
		}

		return {
			txHash: tx.hash,
			sizeUsd: orderParams.sizeUsd,
			isLong: orderParams.isLong
		} as gmxOrderResult;
	} catch (error) {
		console.error(error);
		return;
	}
};

export const checkAndApprove = async (amount) => {
	const usdcContract = new ethers.Contract(usdc, erc20Abi, signer);
	try {
		const allowance = await usdcContract.allowance(
			signer.address,
			transferRouter
		);

		if (allowance.lt(amount)) {
			const tx = await usdcContract.approve(transferRouter, amount);
			console.log('Approving USDC, TxHash: ', tx.hash);
			await tx.wait();
			console.log('Approved');
		} else {
			console.log('Enough allowance');
		}
	} catch (error) {
		console.error('An error occurred while Approving USDC:', error);
	}
};

export const getOrderTypeAndPosition = async (
	market: string,
	isLongOrder: boolean
): Promise<GmxPositionResponse> => {
	const readerContract = new ethers.Contract(reader, ReaderAbi, signer);

	const positions = await readerContract.getAccountPositions(
		dataStore,
		signer.address,
		0,
		ethers.constants.MaxUint256
	);

	const position = positions.find((position) => {
		return position['addresses']['market'] === market;
	});

	const hasLongPosition = position && position['flags']['isLong'];

	// no existing position, always marketIncrease order
	if (!position) return { orderType: gmxOrderType.MarketIncrease };

	// if it's the same order direction, marketIncrease order
	if ((hasLongPosition && isLongOrder) || (!hasLongPosition && !isLongOrder)) {
		const gmxPositionResponse: GmxPositionResponse = {
			orderType: gmxOrderType.MarketIncrease,
			hasLongPosition
		};
		return gmxPositionResponse;
	} else {
		const positionSizeUsd = ethers.utils.formatUnits(
			String(position.numbers.sizeInUsd),
			BASE_DECIMAL
		);

		const collateralAmount = ethers.utils.formatUnits(
			String(position.numbers.collateralAmount),
			usdcDecimal
		);

		return {
			orderType: gmxOrderType.MarketDecrease,
			hasLongPosition,
			positionSizeUsd: Number(positionSizeUsd),
			collateralAmount: Number(collateralAmount)
		};
	}
};

export const getAcceptablePrice = (isLong: boolean, price: number) => {
	// const slippage = 0.05;
	// const multiplier = isLong ? 1 + slippage : 1 - slippage;
	// return ethers.utils.parseUnits(String(price * multiplier), 22);

	// temporary fix
	return isLong ? ethers.constants.MaxUint256 : 1;
};
