'use strict';

const { artifacts, contract, web3 } = require('hardhat');
const { toBN } = web3.utils;

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');
const { toUnit, currentTime, multiplyDecimalRound, divideDecimalRound } = require('../utils')();
const { toBytes32 } = require('../..');
const { setupAllContracts } = require('./setup');
const { getEventByName } = require('./helpers');

const computePrices = (longs, shorts, debt, fee) => {
	const totalOptions = multiplyDecimalRound(debt, toUnit(1).sub(fee));
	return {
		long: divideDecimalRound(longs, totalOptions),
		short: divideDecimalRound(shorts, totalOptions),
	};
};

contract('BinaryOptionMarketManager', accounts => {
	const [initialCreator, bidder] = accounts;

	const sUSDQty = toUnit(10000);

	const expiryDuration = toBN(26 * 7 * 24 * 60 * 60);

	const initialPoolFee = toUnit(0.008);
	const initialCreatorFee = toUnit(0.002);
	const initialRefundFee = toUnit(0.02);

	let manager, exchangeRates, addressResolver, sUSDSynth, oracle;
	let BinaryOptionMarket;
	let BinaryOptionMarketMastercopy;

	const sAUDKey = toBytes32('sAUD');
	const iAUDKey = toBytes32('iAUD');

	const Side = {
		Long: toBN(0),
		Short: toBN(1),
	};

	before(async () => {
		BinaryOptionMarket = artifacts.require('BinaryOptionMarket');
	});

	before(async () => {
		BinaryOptionMarketMastercopy = artifacts.require('BinaryOptionMarketMastercopy');
		BinaryOptionMarketMastercopy.link(await artifacts.require('SafeDecimalMath').new());
		({
			AddressResolver: addressResolver,
			BinaryOptionMarketManager: manager,
			ExchangeRates: exchangeRates,
			SynthsUSD: sUSDSynth,
		} = await setupAllContracts({
			synths: ['sUSD'],
			contracts: [
				'SystemStatus',
				'BinaryOptionMarketManager',
				'AddressResolver',
				'ExchangeRates',
				'FeePool',
				'Synthetix',
			],
			mocks: {
				// Use a real VirtualSynthMastercopy so the spec tests can interrogate deployed vSynths
				BinaryOptionMarketMastercopy: await BinaryOptionMarketMastercopy.new(initialCreator),
			},
			accounts: accounts.slice(10),
		}));

		oracle = await exchangeRates.oracle();

		await exchangeRates.updateRates([sAUDKey], [toUnit(5)], await currentTime(), {
			from: oracle,
		});

		await Promise.all([
			sUSDSynth.issue(initialCreator, sUSDQty),
			sUSDSynth.approve(manager.address, sUSDQty, { from: initialCreator }),
			sUSDSynth.issue(bidder, sUSDQty),
			sUSDSynth.approve(manager.address, sUSDQty, { from: bidder }),
		]);
	});

	addSnapshotBeforeRestoreAfterEach();

	describe('Market creation', () => {
		it('Can create a market', async () => {
			const now = await currentTime();

			const result = await manager.createMarket(
				sAUDKey,
				toUnit(1),
				true,
				[now + 100, now + 200],
				[toUnit(2), toUnit(3)],
				{ from: initialCreator }
			);

			assert.eventEqual(getEventByName({ tx: result, name: 'OwnerChanged' }), 'OwnerChanged', {
				newOwner: manager.address,
			});
			assert.eventEqual(getEventByName({ tx: result, name: 'MarketCreated' }), 'MarketCreated', {
				creator: initialCreator,
				oracleKey: sAUDKey,
				strikePrice: toUnit(1),
				biddingEndDate: toBN(now + 100),
				maturityDate: toBN(now + 200),
				expiryDate: toBN(now + 200).add(expiryDuration),
			});

			const decodedLogs = BinaryOptionMarket.decodeLogs(result.receipt.rawLogs);
			assert.eventEqual(decodedLogs[1], 'Bid', {
				side: Side.Long,
				account: initialCreator,
				value: toUnit(2),
			});
			assert.eventEqual(decodedLogs[2], 'Bid', {
				side: Side.Short,
				account: initialCreator,
				value: toUnit(3),
			});

			const prices = computePrices(
				toUnit(2),
				toUnit(3),
				toUnit(5),
				initialPoolFee.add(initialCreatorFee)
			);
			assert.eventEqual(decodedLogs[3], 'PricesUpdated', {
				longPrice: prices.long,
				shortPrice: prices.short,
			});

			const market = await BinaryOptionMarket.at(
				getEventByName({ tx: result, name: 'MarketCreated' }).args.market
			);

			const times = await market.times();
			assert.bnEqual(times.biddingEnd, toBN(now + 100));
			assert.bnEqual(times.maturity, toBN(now + 200));
			assert.bnEqual(times.expiry, toBN(now + 200).add(expiryDuration));
			const oracleDetails = await market.oracleDetails();
			assert.equal(oracleDetails.key, sAUDKey);
			assert.bnEqual(oracleDetails.strikePrice, toUnit(1));
			assert.bnEqual(oracleDetails.finalPrice, toBN(0));
			assert.equal(await market.creator(), initialCreator);
			assert.equal(await market.owner(), manager.address);
			assert.equal(await market.resolver(), addressResolver.address);

			const bids = await market.totalBids();
			assert.bnEqual(bids[0], toUnit(2));
			assert.bnEqual(bids[1], toUnit(3));
			assert.bnEqual(await market.deposited(), toUnit(5));
			assert.bnEqual(await manager.totalDeposited(), toUnit(5));

			const fees = await market.fees();
			assert.bnEqual(fees.poolFee, initialPoolFee);
			assert.bnEqual(fees.creatorFee, initialCreatorFee);
			assert.bnEqual(fees.refundFee, initialRefundFee);

			assert.bnEqual(await manager.numActiveMarkets(), toBN(1));
			assert.equal((await manager.activeMarkets(0, 100))[0], market.address);
			assert.bnEqual(await manager.numMaturedMarkets(), toBN(0));
			assert.equal((await manager.maturedMarkets(0, 100)).length, 0);
		});

		it('Cannot create markets for invalid keys.', async () => {
			const now = await currentTime();

			const sUSDKey = toBytes32('sUSD');
			const nonRate = toBytes32('nonExistent');

			await assert.revert(
				manager.createMarket(
					sUSDKey,
					toUnit(1),
					true,
					[now + 100, now + 200],
					[toUnit(2), toUnit(3)],
					{
						from: initialCreator,
					}
				),
				'Invalid key'
			);

			await exchangeRates.setInversePricing(
				iAUDKey,
				toUnit(150),
				toUnit(200),
				toUnit(110),
				false,
				false,
				{ from: await exchangeRates.owner() }
			);
			await exchangeRates.updateRates([iAUDKey], [toUnit(151)], await currentTime(), {
				from: oracle,
			});

			await assert.revert(
				manager.createMarket(
					iAUDKey,
					toUnit(1),
					true,
					[now + 100, now + 200],
					[toUnit(2), toUnit(3)],
					{
						from: initialCreator,
					}
				),
				'Invalid key'
			);

			await assert.revert(
				manager.createMarket(
					nonRate,
					toUnit(1),
					true,
					[now + 100, now + 200],
					[toUnit(2), toUnit(3)],
					{
						from: initialCreator,
					}
				),
				'Invalid key'
			);
		});
	});
});
