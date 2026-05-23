import assert from 'node:assert/strict';
import { classifyRegimeObservation, computeMarkovRegime, getRegimeTradeAdjustments } from '../src/services/regime';

assert.equal(classifyRegimeObservation({ buy: 18, sell: 5, hold: 20 }), 'BULL');
assert.equal(classifyRegimeObservation({ buy: 4, sell: 16, hold: 22 }), 'BEAR');
assert.equal(classifyRegimeObservation({ buy: 2, sell: 1, hold: 40 }), 'NEUTRAL');

const bearishArchive = [
  { completedAt: 1, buy: 6, sell: 15, hold: 20 },
  { completedAt: 2, buy: 4, sell: 17, hold: 18 },
  { completedAt: 3, buy: 5, sell: 16, hold: 19 },
  { completedAt: 4, buy: 3, sell: 19, hold: 16 },
  { completedAt: 5, buy: 4, sell: 18, hold: 17 },
];

const bearishRegime = computeMarkovRegime(bearishArchive, { buy: 5, sell: 18, hold: 15, updatedAt: Date.now() });
assert.equal(bearishRegime.state, 'BEAR');
assert.ok(bearishRegime.bearProbability > bearishRegime.bullProbability, 'expected higher bear probability in bearish sequence');

const sellAdjustment = getRegimeTradeAdjustments(bearishRegime, 'SELL');
const buyAdjustment = getRegimeTradeAdjustments(bearishRegime, 'BUY');
assert.ok(sellAdjustment.minScoreDelta < 0, 'aligned bear-side trades should get easier thresholds');
assert.ok(buyAdjustment.minScoreDelta > 0, 'countertrend buy trades should get stricter thresholds');

const neutralRegime = computeMarkovRegime([], { buy: 2, sell: 2, hold: 40, updatedAt: Date.now() });
assert.equal(neutralRegime.state, 'NEUTRAL');
assert.ok(getRegimeTradeAdjustments(neutralRegime, 'BUY').minScoreDelta >= 0, 'neutral regime should not loosen thresholds');

console.log('markov regime validation passed');
console.log(JSON.stringify({
  bearishRegime,
  sellAdjustment,
  buyAdjustment,
  neutralRegime,
}, null, 2));
