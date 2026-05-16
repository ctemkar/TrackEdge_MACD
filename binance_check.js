import ccxt from 'ccxt';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
    try {
        const exchange = new ccxt.binance({
            apiKey: process.env.BINANCE_API_KEY,
            secret: process.env.BINANCE_API_SECRET,
            options: {
                'defaultType': 'future',
            },
        });

        // (1) fetchPositions
        const positions = await exchange.fetchPositions();
        const nonZeroPositions = positions.filter(p => parseFloat(p.contracts) !== 0).map(p => ({
            symbol: p.symbol,
            contracts: p.contracts,
            side: p.side,
            entryPrice: p.entryPrice,
            unrealizedPnl: p.unrealizedPnl
        }));

        // (2) fapiPrivateV2GetPositionRisk
        const riskData = await exchange.fapiPrivateV2GetPositionRisk();
        const nonZeroRisk = riskData.filter(r => parseFloat(r.positionAmt) !== 0).map(r => ({
            symbol: r.symbol,
            positionAmt: r.positionAmt,
            entryPrice: r.entryPrice,
            unRealizedProfit: r.unRealizedProfit
        }));

        console.log(JSON.stringify({
            fetchPositionsCount: nonZeroPositions.length,
            fetchPositionsTop: nonZeroPositions.slice(0, 5),
            riskDataCount: nonZeroRisk.length,
            riskData: nonZeroRisk.slice(0, 5)
        }, null, 2));

    } catch (e) {
        console.error(JSON.stringify({ error: e.message }));
    }
}

main();
