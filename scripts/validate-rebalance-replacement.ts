import assert from 'node:assert/strict';
import { pickReplacementOpportunity, type ReplacementHolding } from '../src/services/rebalance';
import type { MarketScanResult } from '../src/services/scanner';

const buildResult = ({
  symbol,
  overall,
  score,
  lastPrice,
  tp1Price,
  priorityRank,
}: {
  symbol: string;
  overall: 'BUY' | 'SELL' | 'HOLD';
  score: number;
  lastPrice: number;
  tp1Price: number;
  priorityRank: number;
}): MarketScanResult => ({
  symbol,
  lastPrice,
  change24h: 0,
  priorityRank,
  signal: {
    trend: overall === 'SELL' ? 'DOWN' : overall === 'BUY' ? 'UP' : 'NEUTRAL',
    volume: true,
    confluence: {
      rsi: 'NEUTRAL',
      macd: overall === 'SELL' ? 'BEARISH' : overall === 'BUY' ? 'BULLISH' : 'NEUTRAL',
      macdHistogram: 'NEUTRAL',
      emaCrossover: overall === 'SELL' ? 'BEARISH' : overall === 'BUY' ? 'BULLISH' : 'NEUTRAL',
      support: false,
    },
    overall,
    score,
    macdScore: overall === 'SELL' ? 8 : 7,
    exitSignal: 'NONE',
    tradePlan: {
      stopPrice: overall === 'SELL' ? lastPrice * 1.02 : lastPrice * 0.98,
      tp1Price,
      tp2Price: tp1Price,
      riskPerUnit: Math.abs(lastPrice - tp1Price),
      trailingBufferPct: 0.012,
    },
  },
});

const shortHoldings: ReplacementHolding[] = [
  { id: 'h1', symbol: 'WEAKUSDT', amount: 1, side: 'SHORT', entryPrice: 100 },
  { id: 'h2', symbol: 'STRONGUSDT', amount: 1, side: 'SHORT', entryPrice: 100 },
];

const weakHoldingResult = buildResult({
  symbol: 'WEAKUSDT',
  overall: 'HOLD',
  score: 4.8,
  lastPrice: 100,
  tp1Price: 99.9,
  priorityRank: 10,
});

const strongerHoldingResult = buildResult({
  symbol: 'STRONGUSDT',
  overall: 'SELL',
  score: 2.0,
  lastPrice: 100,
  tp1Price: 98.2,
  priorityRank: 26,
});

const incomingShort = {
  side: 'SELL' as const,
  pick: buildResult({
    symbol: 'NEWSHORTUSDT',
    overall: 'SELL',
    score: 1.8,
    lastPrice: 100,
    tp1Price: 97.8,
    priorityRank: 30,
  }),
};

const positiveScenario = pickReplacementOpportunity({
  isRealMode: true,
  baseAvailableSlots: 0,
  estimatedRoundTripFrictionBps: 18,
  entry: incomingShort,
  currentHoldings: shortHoldings,
  scanResultsByRiskKey: new Map([
    ['WEAK', weakHoldingResult],
    ['STRONG', strongerHoldingResult],
  ]),
  holdingPrices: {
    WEAKUSDT: 100,
    STRONGUSDT: 100,
  },
});

assert.ok(positiveScenario, 'expected a replacement opportunity when slots are full and candidate is materially better');
assert.equal(positiveScenario.holding.symbol, 'WEAKUSDT');
assert.match(positiveScenario.reason, /replacement edge \+/i);

const availableSlotScenario = pickReplacementOpportunity({
  isRealMode: true,
  baseAvailableSlots: 2,
  estimatedRoundTripFrictionBps: 18,
  entry: incomingShort,
  currentHoldings: shortHoldings,
  scanResultsByRiskKey: new Map([
    ['WEAK', weakHoldingResult],
    ['STRONG', strongerHoldingResult],
  ]),
  holdingPrices: {
    WEAKUSDT: 100,
    STRONGUSDT: 100,
  },
});

assert.equal(availableSlotScenario, null, 'should not replace when there are free slots');

const weakIncomingShort = {
  side: 'SELL' as const,
  pick: buildResult({
    symbol: 'MARGINALUSDT',
    overall: 'SELL',
    score: 2.4,
    lastPrice: 100,
    tp1Price: 99.85,
    priorityRank: 11,
  }),
};

const insufficientEdgeScenario = pickReplacementOpportunity({
  isRealMode: true,
  baseAvailableSlots: 0,
  estimatedRoundTripFrictionBps: 18,
  entry: weakIncomingShort,
  currentHoldings: shortHoldings,
  scanResultsByRiskKey: new Map([
    ['WEAK', weakHoldingResult],
    ['STRONG', strongerHoldingResult],
  ]),
  holdingPrices: {
    WEAKUSDT: 100,
    STRONGUSDT: 100,
  },
});

assert.equal(insufficientEdgeScenario, null, 'should not replace when the edge improvement does not clear friction');

console.log('replacement validation passed');
console.log(JSON.stringify({
  replacedHolding: positiveScenario.holding.symbol,
  reason: positiveScenario.reason,
  noSwapWhenSlotsFree: availableSlotScenario === null,
  noSwapWhenEdgeThin: insufficientEdgeScenario === null,
}, null, 2));