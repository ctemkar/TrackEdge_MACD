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
    emaCrossover: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    support: boolean;
  };
  overall: 'BUY' | 'SELL' | 'HOLD';
  score: number;
}

export function evaluateStrategy(
  candles: Candle[],
  indicators: IndicatorResult,
  config: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): StrategySignal {
  if (candles.length < 2) return { 
    trend: 'NEUTRAL', 
    volume: false, 
    confluence: { rsi: 'NEUTRAL', macd: 'NEUTRAL', emaCrossover: 'NEUTRAL', support: false }, 
    overall: 'HOLD', 
    score: 0 
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
  const volumeConfirmed = lastCandle.volume > avgVolume * config.volumeMultiplier;

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

  let overall: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  // Strict entry rule: only buy when MACD crosses above signal on the daily candle.
  const buySignal = macdCrossover === 'BULLISH';
  // Mirrored short rule: only sell/short when MACD crosses below signal on the daily candle.
  const sellSignal = macdCrossover === 'BEARISH';

  let score = 0;
  if (buySignal) {
    overall = 'BUY';
    // No extra criteria: a valid bullish crossover is a full-strength entry.
    score = config.maxScore;
  } else if (sellSignal) {
    overall = 'SELL';
    // No extra criteria: a valid bearish crossover is a full-strength short entry.
    score = config.maxScore;
  } else {
    // No bullish crossover: stay flat.
    score = 0;
  }

  return {
    trend,
    volume: volumeConfirmed,
    confluence: {
      rsi: rsiMode,
      macd: macdMode,
      emaCrossover,
      support: nearSupport
    },
    overall,
    score: Math.min(config.maxScore, score)
  };
}
