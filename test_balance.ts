import ccxt from 'ccxt';
import * as dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.BINANCE_LIVE_API_KEY;
const secret = process.env.BINANCE_LIVE_SECRET;

async function runTest(label: string, options: any, params: any, baseUrlUpdate: boolean = false) {
    try {
        const exchange = new ccxt.binance({
            apiKey,
            secret,
            options: { ...options }
        });

        if (baseUrlUpdate && process.env.BINANCE_LIVE_BASE_URL) {
            exchange.urls['api'] = {
                ...exchange.urls['api'] as object,
                'papi': process.env.BINANCE_LIVE_BASE_URL
            };
        }

        await exchange.fetchBalance(params);
        console.log(`${label}: PASS`);
    } catch (e: any) {
        console.log(`${label}: FAIL - ${e.message}`);
    }
}

async function main() {
    console.log('API Key present:', !!apiKey);
    console.log('Secret present:', !!secret);
    if (!apiKey || !secret) {
        console.error('Missing BINANCE_LIVE_API_KEY or BINANCE_LIVE_SECRET');
        process.exit(1);
    }

    await runTest('A', { defaultType: 'future' }, { type: 'future' });
    await runTest('B', { defaultType: 'future', portfolioMargin: true }, { type: 'future' });
    await runTest('C', { defaultType: 'future', portfolioMargin: true }, {});
    await runTest('D', { defaultType: 'future', portfolioMargin: true }, {}, true);
}

main();
