import { SMA, MACD, RSI, EMA } from 'technicalindicators';

export interface StrategyConfig {
  trendSmaPeriod: number;
  macdFastPeriod: number;
  macdSlowPeriod: number;
  macdSignalPeriod: number;
  rsiPeriod: number;
  emaFastPeriod: number;
  emaSlowPeriod: number;
  volumeLookback: number;
  volumeMultiplier: number;
  rsiOverbought: number;
  rsiOversold: number;
  supportLookback: number;
  nearSupportPercent: number;
  nearResistancePercent: number;
  crossoverScore: number;
  continuationScore: number;
  contextTrendScore: number;
  contextVolumeScore: number;
  contextMacdScore: number;
  contextEmaScore: number;
  contextRsiScore: number;
  maxScore: number;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  trendSmaPeriod: 200,
  macdFastPeriod: 12,
  macdSlowPeriod: 26,
  macdSignalPeriod: 9,
  rsiPeriod: 14,
  emaFastPeriod: 9,
  emaSlowPeriod: 21,
  volumeLookback: 20,
  volumeMultiplier: 1.1,
  rsiOverbought: 70,
  rsiOversold: 45,
  supportLookback: 50,
  nearSupportPercent: 2,
  nearResistancePercent: 2,
  crossoverScore: 10,
  continuationScore: 6,
  contextTrendScore: 1,
  contextVolumeScore: 1,
  contextMacdScore: 1,
  contextEmaScore: 1,
  contextRsiScore: 1,
  maxScore: 10,
};

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndicatorResult {
  sma200: number[];
  macd: { MACD: number; signal: number; histogram: number }[];
  rsi: number[];
  ema9: number[];
  ema21: number[];
}

export function calculateIndicators(candles: Candle[], config: StrategyConfig = DEFAULT_STRATEGY_CONFIG): IndicatorResult {
  const closes = candles.map(c => c.close);
  const trendSmaPeriod = Math.max(2, Math.floor(config.trendSmaPeriod));
  const macdFastPeriod = Math.max(1, Math.floor(config.macdFastPeriod));
  const macdSlowPeriod = Math.max(macdFastPeriod + 1, Math.floor(config.macdSlowPeriod));
  const macdSignalPeriod = Math.max(1, Math.floor(config.macdSignalPeriod));
  const rsiPeriod = Math.max(2, Math.floor(config.rsiPeriod));
  const emaFastPeriod = Math.max(1, Math.floor(config.emaFastPeriod));
  const emaSlowPeriod = Math.max(emaFastPeriod + 1, Math.floor(config.emaSlowPeriod));

  const sma200 = SMA.calculate({ period: trendSmaPeriod, values: closes });
  const macd = MACD.calculate({
    values: closes,
    fastPeriod: macdFastPeriod,
    slowPeriod: macdSlowPeriod,
    signalPeriod: macdSignalPeriod,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
  const rsi = RSI.calculate({ period: rsiPeriod, values: closes });
  const ema9 = EMA.calculate({ period: emaFastPeriod, values: closes });
  const ema21 = EMA.calculate({ period: emaSlowPeriod, values: closes });

  return {
    sma200: new Array(candles.length - sma200.length).fill(null).concat(sma200),
    macd: new Array(candles.length - macd.length).fill(null).concat(macd),
    rsi: new Array(candles.length - rsi.length).fill(null).concat(rsi),
    ema9: new Array(candles.length - ema9.length).fill(null).concat(ema9),
    ema21: new Array(candles.length - ema21.length).fill(null).concat(ema21)
  };
}

export interface StrategySignal {
  trend: 'UP' | 'DOWN' | 'NEUTRAL';
  volume: boolean;
  confluence: {
    rsi: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL';
    macd: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    macdHistogram: 'BULLISH_ACCELERATION' | 'BULLISH_FADE' | 'BEARISH_ACCELERATION' | 'BEARISH_FADE' | 'NEUTRAL';
    emaCrossover: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    support: boolean;
  };
  overall: 'BUY' | 'SELL' | 'HOLD';
  score: number;
  macdScore: number;
  exitSignal: 'EXIT_LONG' | 'EXIT_SHORT' | 'NONE';
  holdReason?: 'UNCLEAR_SETUP' | 'MOVE_ALREADY_HAPPENED' | 'WEAK_MACD' | 'INSUFFICIENT_CONFIRMATION';
  rejectReasons?: string[];
  tradePlan?: {
    stopPrice: number;
    tp1Price: number;
    tp2Price: number;
    riskPerUnit: number;
    trailingBufferPct: number;
  };
}

export function evaluateStrategy(
  candles: Candle[],
  indicators: IndicatorResult,
  config: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): StrategySignal {
  if (candles.length < 2) return { 
    trend: 'NEUTRAL', 
    volume: false, 
    confluence: { rsi: 'NEUTRAL', macd: 'NEUTRAL', macdHistogram: 'NEUTRAL', emaCrossover: 'NEUTRAL', support: false }, 
    overall: 'HOLD', 
    score: 0,
    macdScore: 0,
    exitSignal: 'NONE',
    holdReason: 'INSUFFICIENT_CONFIRMATION',
    rejectReasons: ['not enough candles for evaluation'],
    tradePlan: undefined,
  };

  const lastCandle = candles[candles.length - 1];
  const lastSMA = indicators.sma200[indicators.sma200.length - 1];
  const lastRSI = indicators.rsi[indicators.rsi.length - 1];
  const lastMACD = indicators.macd[indicators.macd.length - 1];
  const prevMACD = indicators.macd[indicators.macd.length - 2];
  const lastEMA9 = indicators.ema9[indicators.ema9.length - 1];
  const lastEMA21 = indicators.ema21[indicators.ema21.length - 1];
  const prevEMA9 = indicators.ema9[indicators.ema9.length - 2];
  const prevEMA21 = indicators.ema21[indicators.ema21.length - 2];
  
  // Trend Following: Direction of 200-day MA
  const trend: 'UP' | 'DOWN' | 'NEUTRAL' = lastSMA ? (lastCandle.close > lastSMA ? 'UP' : 'DOWN') : 'NEUTRAL';

  // Volume Confirmation: Purchase volume rising slightly
  const volumeLookback = Math.max(1, Math.floor(config.volumeLookback));
  const recentVolumeCandles = candles.slice(-volumeLookback);
  const avgVolume = recentVolumeCandles.reduce((acc, c) => acc + c.volume, 0) / recentVolumeCandles.length;
  const softenedVolumeMultiplier = Math.max(1, config.volumeMultiplier * 0.82);
  const volumeConfirmed = lastCandle.volume > avgVolume * softenedVolumeMultiplier;
  const volumeSupportive = lastCandle.volume > avgVolume * Math.max(0.9, softenedVolumeMultiplier * 0.84);
  const shortVolumeSupportive = lastCandle.volume > avgVolume * Math.max(0.82, softenedVolumeMultiplier * 0.76);

  // Confluence
  const rsiMode: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL' = lastRSI > config.rsiOverbought ? 'OVERBOUGHT' : lastRSI < config.rsiOversold ? 'OVERSOLD' : 'NEUTRAL';
  const macdMode: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = lastMACD ? (lastMACD.MACD > lastMACD.signal ? 'BULLISH' : 'BEARISH') : 'NEUTRAL';
  
  // MACD Crossover Detection
  let macdCrossover: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (lastMACD && prevMACD) {
    if (prevMACD.MACD <= prevMACD.signal && lastMACD.MACD > lastMACD.signal) {
      macdCrossover = 'BULLISH';
    }
    if (prevMACD.MACD >= prevMACD.signal && lastMACD.MACD < lastMACD.signal) {
      macdCrossover = 'BEARISH';
    }
  }

  // EMA Crossover Logic
  let emaCrossover: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (lastEMA9 && lastEMA21 && prevEMA9 && prevEMA21) {
    if (lastEMA9 > lastEMA21) {
      emaCrossover = 'BULLISH';
    } else {
      emaCrossover = 'BEARISH';
    }
  }

  // Simple support/resistance detection (local min/max in last 50 candles)
  const supportLookback = Math.max(2, Math.floor(config.supportLookback));
  const last50Closes = candles.slice(-supportLookback).map(c => c.close);
  const supportLevel = Math.min(...last50Closes);
  const resistanceLevel = Math.max(...last50Closes);
  const nearSupport = lastCandle.close <= supportLevel * (1 + (config.nearSupportPercent / 100));
  const nearResistance = lastCandle.close >= resistanceLevel * (1 - (config.nearResistancePercent / 100));

  const histNow = lastMACD?.histogram ?? 0;
  const histPrev = prevMACD?.histogram ?? 0;
  const histogramDelta = histNow - histPrev;
  const histogramRising = histNow > histPrev;
  const bullishMomentum = histNow > 0 && histogramRising;
  const bearishMomentum = histNow < 0 && !histogramRising;
  const weakeningMomentum = Math.abs(histNow) < Math.abs(histPrev);
  const macdHistogramMode: 'BULLISH_ACCELERATION' | 'BULLISH_FADE' | 'BEARISH_ACCELERATION' | 'BEARISH_FADE' | 'NEUTRAL' =
    histNow > 0
      ? (histogramDelta >= 0 ? 'BULLISH_ACCELERATION' : 'BULLISH_FADE')
      : histNow < 0
        ? (histogramDelta <= 0 ? 'BEARISH_ACCELERATION' : 'BEARISH_FADE')
        : 'NEUTRAL';

  // Sideways/choppy detector: frequent MACD crossovers in recent bars.
  let recentCrossovers = 0;
  const crossoverLookback = Math.min(14, indicators.macd.length - 1);
  for (let i = indicators.macd.length - crossoverLookback; i < indicators.macd.length; i += 1) {
    const curr = indicators.macd[i];
    const prev = indicators.macd[i - 1];
    if (!curr || !prev) continue;
    const crossedUp = prev.MACD <= prev.signal && curr.MACD > curr.signal;
    const crossedDown = prev.MACD >= prev.signal && curr.MACD < curr.signal;
    if (crossedUp || crossedDown) recentCrossovers += 1;
  }
  const choppyMarket = recentCrossovers >= 5;

  // Volatility guardrail (ATR-like percentage using high/low range).
  const volatilityLookback = Math.min(14, candles.length);
  const recentRanges = candles.slice(-volatilityLookback).map(c => (c.high - c.low) / Math.max(c.close, 1e-12));
  const avgRangePct = recentRanges.length > 0
    ? (recentRanges.reduce((sum, value) => sum + value, 0) / recentRanges.length) * 100
    : 0;
  const extremeVolatility = avgRangePct > 11;

  // Late-entry guard: avoid chasing after an overextended candle.
  const candleBodyPct = Math.abs(lastCandle.close - lastCandle.open) / Math.max(lastCandle.open, 1e-12) * 100;
  const lateEntryRisk = candleBodyPct > Math.max(1.9, avgRangePct * 1.05);

  const longStop = Math.min(lastCandle.close * 0.985, supportLevel * 0.997);
  const longTarget = Math.max(resistanceLevel, lastCandle.close * 1.025);
  const longRisk = Math.max(lastCandle.close - longStop, 1e-12);
  const longReward = Math.max(longTarget - lastCandle.close, 0);
  const longRiskReward = longReward / longRisk;

  const shortStop = Math.max(lastCandle.close * 1.015, resistanceLevel * 1.003);
  const shortTarget = Math.min(supportLevel, lastCandle.close * 0.975);
  const shortRisk = Math.max(shortStop - lastCandle.close, 1e-12);
  const shortReward = Math.max(lastCandle.close - shortTarget, 0);
  const shortRiskReward = shortReward / shortRisk;

  const trendBullish = (trend === 'UP' && emaCrossover !== 'BEARISH') || (trend !== 'DOWN' && emaCrossover === 'BULLISH');
  const trendBearish = (trend === 'DOWN' && emaCrossover !== 'BULLISH') || (trend !== 'UP' && emaCrossover === 'BEARISH');

  const computeDirectionalMacdScore = (direction: 'LONG' | 'SHORT') => {
    let directionalScore = 0;
    const favorsDirection = direction === 'LONG'
      ? macdMode === 'BULLISH'
      : macdMode === 'BEARISH';
    const crossoverSupports = direction === 'LONG'
      ? macdCrossover === 'BULLISH'
      : macdCrossover === 'BEARISH';
    const momentumSupports = direction === 'LONG'
      ? bullishMomentum
      : bearishMomentum;
    const histogramSupports = direction === 'LONG'
      ? macdHistogramMode === 'BULLISH_ACCELERATION' || macdHistogramMode === 'BULLISH_FADE'
      : macdHistogramMode === 'BEARISH_ACCELERATION' || macdHistogramMode === 'BEARISH_FADE';
    const accelerating = direction === 'LONG'
      ? macdHistogramMode === 'BULLISH_ACCELERATION'
      : macdHistogramMode === 'BEARISH_ACCELERATION';
    const trendSupports = direction === 'LONG' ? trendBullish : trendBearish;

    if (favorsDirection) directionalScore += 3;
    if (crossoverSupports) directionalScore += 3;
    if (momentumSupports) directionalScore += 2;
    if (histogramSupports) directionalScore += 1;
    if (accelerating) directionalScore += 1;
    if (trendSupports) directionalScore += 1;

    return Math.min(10, directionalScore);
  };

  const longMacdScore = computeDirectionalMacdScore('LONG');
  const shortMacdScore = computeDirectionalMacdScore('SHORT');
  const weakMacdLong = longMacdScore <= 4;
  const weakMacdShort = shortMacdScore <= 4;
  const conditionalMacdLong = longMacdScore >= 5 && longMacdScore <= 6;
  const conditionalMacdShort = shortMacdScore >= 5 && shortMacdScore <= 6;
  const strongMacdLong = longMacdScore >= 7;
  const strongMacdShort = shortMacdScore >= 7;

  // Keep EMA + trend alignment as mandatory regime filter; score the rest.
  const longBase = (macdCrossover === 'BULLISH' || bullishMomentum) && trendBullish;
  const shortBase = (macdCrossover === 'BEARISH' || bearishMomentum) && trendBearish;

  let longChecks = 0;
  if (volumeSupportive) longChecks += 1;
  if (nearSupport || !nearResistance) longChecks += 1;
  if (!lateEntryRisk) longChecks += 1;
  if (!choppyMarket) longChecks += 1;
  if (!extremeVolatility) longChecks += 1;
  if (longRiskReward >= 1.25) longChecks += 1;

  let shortChecks = 0;
  if (shortVolumeSupportive) shortChecks += 1;
  if (nearResistance || !nearSupport) shortChecks += 1;
  if (!lateEntryRisk) shortChecks += 1;
  if (!choppyMarket) shortChecks += 1;
  if (!extremeVolatility) shortChecks += 1;
  if (shortRiskReward >= 1.25) shortChecks += 1;

  const longOtherSignalsVeryStrong = longChecks >= 5 && longRiskReward >= 1.6 && volumeSupportive && !lateEntryRisk && !choppyMarket && !extremeVolatility;
  const shortOtherSignalsVeryStrong = shortChecks >= 4 && shortRiskReward >= 1.45 && shortVolumeSupportive && !lateEntryRisk && !choppyMarket && !extremeVolatility;

  const longQuality = longBase && !weakMacdLong && (strongMacdLong ? longChecks >= 4 : conditionalMacdLong && longOtherSignalsVeryStrong);
  const shortQuality = shortBase && !weakMacdShort && (strongMacdShort ? shortChecks >= 3 : conditionalMacdShort && shortOtherSignalsVeryStrong);

  const computeTrendScore = (direction: 'LONG' | 'SHORT') => {
    let directionalScore = 0;
    const trendSupports = direction === 'LONG' ? trend === 'UP' : trend === 'DOWN';
    const emaSupports = direction === 'LONG' ? emaCrossover === 'BULLISH' : emaCrossover === 'BEARISH';
    const structureSupports = direction === 'LONG'
      ? (nearSupport || !nearResistance)
      : (nearResistance || !nearSupport);

    if (trendSupports) directionalScore += 5;
    if (emaSupports) directionalScore += 3;
    if (structureSupports) directionalScore += 2;

    return Math.min(10, directionalScore);
  };

  const computeVolumeMomentumScore = (direction: 'LONG' | 'SHORT') => {
    let directionalScore = 0;
    const momentumSupports = direction === 'LONG' ? bullishMomentum : bearishMomentum;
    const histogramSupports = direction === 'LONG'
      ? macdHistogramMode === 'BULLISH_ACCELERATION' || macdHistogramMode === 'BULLISH_FADE'
      : macdHistogramMode === 'BEARISH_ACCELERATION' || macdHistogramMode === 'BEARISH_FADE';

    if (direction === 'SHORT' ? shortVolumeSupportive : volumeSupportive) directionalScore += 4;
    if (momentumSupports) directionalScore += 3;
    if (histogramSupports) directionalScore += 1;
    if (!choppyMarket) directionalScore += 1;
    if (!lateEntryRisk && !extremeVolatility) directionalScore += 1;

    return Math.min(10, directionalScore);
  };

  const computeRiskRewardScore = (riskReward: number, checks: number) => {
    let directionalScore = 0;
    if (riskReward >= 3) directionalScore += 6;
    else if (riskReward >= 2) directionalScore += 5;
    else if (riskReward >= 1.5) directionalScore += 4;
    else if (riskReward >= 1.2) directionalScore += 3;
    else if (riskReward >= 1.0) directionalScore += 1;

    if (!lateEntryRisk) directionalScore += 2;
    if (!extremeVolatility) directionalScore += 1;
    if (checks >= 5) directionalScore += 1;

    return Math.min(10, directionalScore);
  };

  const computeWeightedTradeScore = (
    directionalMacdScore: number,
    directionalTrendScore: number,
    directionalVolumeMomentumScore: number,
    directionalRiskRewardScore: number,
  ) => {
    const macdWeight = 0.30 * Math.max(0.1, config.contextMacdScore);
    const trendWeight = (0.20 * Math.max(0.1, config.contextTrendScore)) + (0.10 * Math.max(0.1, config.contextEmaScore));
    const volumeWeight = 0.20 * Math.max(0.1, config.contextVolumeScore);
    const riskWeight = 0.20 * Math.max(0.1, config.contextRsiScore);
    const totalWeight = macdWeight + trendWeight + volumeWeight + riskWeight;
    const weighted = ((directionalMacdScore * macdWeight)
      + (directionalTrendScore * trendWeight)
      + (directionalVolumeMomentumScore * volumeWeight)
      + (directionalRiskRewardScore * riskWeight)) / Math.max(0.0001, totalWeight);

    return Math.min(config.maxScore, Number(weighted.toFixed(1)));
  };

  const longTrendScore = computeTrendScore('LONG');
  const shortTrendScore = computeTrendScore('SHORT');
  const longVolumeMomentumScore = computeVolumeMomentumScore('LONG');
  const shortVolumeMomentumScore = computeVolumeMomentumScore('SHORT');
  const longRiskRewardScore = computeRiskRewardScore(longRiskReward, longChecks);
  const shortRiskRewardScore = computeRiskRewardScore(shortRiskReward, shortChecks);
  const bullishMacdConfirmed = macdMode === 'BULLISH' || macdCrossover === 'BULLISH' || bullishMomentum;
  const bearishMacdConfirmed = macdMode === 'BEARISH' || macdCrossover === 'BEARISH' || bearishMomentum;
  const bearishMacdReversal = (macdMode === 'BEARISH' || macdCrossover === 'BEARISH' || macdHistogramMode === 'BEARISH_ACCELERATION') && shortMacdScore >= 7;
  const bullishMacdReversal = (macdMode === 'BULLISH' || macdCrossover === 'BULLISH' || macdHistogramMode === 'BULLISH_ACCELERATION') && longMacdScore >= 7;
  const longTradeDeteriorating = longRiskReward < 1.05 || nearResistance || extremeVolatility || (weakeningMomentum && !trendBullish);
  const shortTradeDeteriorating = shortRiskReward < 1.05 || nearSupport || extremeVolatility || (weakeningMomentum && !trendBearish);
  const longWeightedScore = computeWeightedTradeScore(
    longMacdScore,
    longTrendScore,
    longVolumeMomentumScore,
    longRiskRewardScore,
  );
  const shortWeightedScore = computeWeightedTradeScore(
    shortMacdScore,
    shortTrendScore,
    shortVolumeMomentumScore,
    shortRiskRewardScore,
  );
  const finalTradeScore = Math.min(
    config.maxScore,
    Math.max(0, Number((5 + ((longWeightedScore - shortWeightedScore) / 2)).toFixed(1))),
  );
  const directionalEdge = Math.abs(longWeightedScore - shortWeightedScore);
  const recentReferenceIndex = Math.max(0, candles.length - 4);
  const recentReferenceClose = candles[recentReferenceIndex]?.close || lastCandle.close;
  const recentMovePct = recentReferenceClose > 0
    ? ((lastCandle.close - recentReferenceClose) / recentReferenceClose) * 100
    : 0;
  const longMoveAlreadyHappened = recentMovePct > Math.max(2.2, avgRangePct * 1.15) || (nearResistance && candleBodyPct > Math.max(1.2, avgRangePct * 0.7));
  const shortMoveAlreadyHappened = recentMovePct < -Math.max(2.2, avgRangePct * 1.15) || (nearSupport && candleBodyPct > Math.max(1.2, avgRangePct * 0.7));
  const unclearSetup = directionalEdge < 0.8
    || (Math.abs(finalTradeScore - 5) < 0.55)
    || (longWeightedScore >= 6 && shortWeightedScore >= 6)
    || (!bullishMacdConfirmed && !bearishMacdConfirmed);
  const longEntryQualified = !unclearSetup && !longMoveAlreadyHappened && longQuality && bullishMacdConfirmed && finalTradeScore >= 6.8;
  const shortEntryQualified = !unclearSetup && !shortMoveAlreadyHappened && shortQuality && bearishMacdConfirmed && finalTradeScore <= 3.2;
  const trailingBufferPct = Math.max(0.008, Math.min(0.025, (avgRangePct / 100) * 0.6 || 0.012));
  const longTradePlan = {
    stopPrice: Number(longStop.toFixed(8)),
    tp1Price: Number((lastCandle.close + (longRisk * 1.25)).toFixed(8)),
    tp2Price: Number((lastCandle.close + (longRisk * 2.4)).toFixed(8)),
    riskPerUnit: Number(longRisk.toFixed(8)),
    trailingBufferPct: Number(trailingBufferPct.toFixed(4)),
  };
  const shortTradePlan = {
    stopPrice: Number(shortStop.toFixed(8)),
    tp1Price: Number((lastCandle.close - (shortRisk * 1.25)).toFixed(8)),
    tp2Price: Number((lastCandle.close - (shortRisk * 2.4)).toFixed(8)),
    riskPerUnit: Number(shortRisk.toFixed(8)),
    trailingBufferPct: Number(trailingBufferPct.toFixed(4)),
  };

  let overall: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  let score = 0;
  let macdScore = 0;
  let exitSignal: 'EXIT_LONG' | 'EXIT_SHORT' | 'NONE' = 'NONE';
  let holdReason: StrategySignal['holdReason'] = undefined;
  let rejectReasons: string[] | undefined = undefined;
  let tradePlan: StrategySignal['tradePlan'] = undefined;
  if (longEntryQualified) {
    overall = 'BUY';
    macdScore = longMacdScore;
    score = finalTradeScore;
    tradePlan = longTradePlan;
  } else if (shortEntryQualified) {
    overall = 'SELL';
    macdScore = shortMacdScore;
    score = finalTradeScore;
    tradePlan = shortTradePlan;
  } else {
    score = finalTradeScore;
    macdScore = Math.max(longMacdScore, shortMacdScore);
    const reasons: string[] = [];
    const pushReason = (reason: string) => {
      if (!reasons.includes(reason)) reasons.push(reason);
    };

    if (!trendBullish && !trendBearish) pushReason('trend and EMA regime are not aligned');
    if (!(trendBearish ? shortVolumeSupportive : volumeSupportive)) pushReason('volume is below confirmation threshold');
    if (lateEntryRisk) pushReason('late-entry risk after an extended candle');
    if (choppyMarket) pushReason('market is too choppy');
    if (extremeVolatility) pushReason('volatility is too high');
    if (longRiskReward < 1.25 && shortRiskReward < 1.25) pushReason('risk/reward is below target');
    if (!bullishMacdConfirmed && !bearishMacdConfirmed) pushReason('MACD confirmation is missing');
    if (weakMacdLong && weakMacdShort) pushReason('MACD strength is too weak');
    if (longMoveAlreadyHappened || shortMoveAlreadyHappened) pushReason('the move already happened before entry');
    if (directionalEdge < 0.8) pushReason('directional edge is too weak');
    if (Math.abs(finalTradeScore - 5) < 0.75) pushReason('trade score is still near neutral');
    if (longWeightedScore >= 6 && shortWeightedScore >= 6) pushReason('long and short cases are conflicting');
    if (trendBullish && !longQuality) pushReason('long setup lacks enough confirmation checks');
    if (trendBearish && !shortQuality) pushReason('short setup lacks enough confirmation checks');

    if (unclearSetup) {
      holdReason = 'UNCLEAR_SETUP';
    } else if (longMoveAlreadyHappened || shortMoveAlreadyHappened) {
      holdReason = 'MOVE_ALREADY_HAPPENED';
    } else if (weakMacdLong && weakMacdShort) {
      holdReason = 'WEAK_MACD';
    } else {
      holdReason = 'INSUFFICIENT_CONFIRMATION';
    }
    rejectReasons = reasons.slice(0, 4);
  }

  if (bearishMacdReversal && longTradeDeteriorating) {
    exitSignal = 'EXIT_LONG';
    macdScore = Math.max(macdScore, shortMacdScore);
  } else if (bullishMacdReversal && shortTradeDeteriorating) {
    exitSignal = 'EXIT_SHORT';
    macdScore = Math.max(macdScore, longMacdScore);
  }

  return {
    trend,
    volume: volumeConfirmed,
    confluence: {
      rsi: rsiMode,
      macd: macdMode,
      macdHistogram: macdHistogramMode,
      emaCrossover,
      support: nearSupport
    },
    overall,
    score: Math.min(config.maxScore, score),
    macdScore,
    exitSignal,
    holdReason,
    rejectReasons,
    tradePlan,
  };
}
