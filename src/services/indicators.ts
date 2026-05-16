import { SMA, MACD, RSI, EMA } from 'technicalindicators';

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

export function calculateIndicators(candles: Candle[]): IndicatorResult {
  const closes = candles.map(c => c.close);

  const sma200 = SMA.calculate({ period: 200, values: closes });
  const macd = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
  const rsi = RSI.calculate({ period: 14, values: closes });
  const ema9 = EMA.calculate({ period: 9, values: closes });
  const ema21 = EMA.calculate({ period: 21, values: closes });

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

export function evaluateStrategy(candles: Candle[], indicators: IndicatorResult): StrategySignal {
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
  const avgVolume = candles.slice(-20).reduce((acc, c) => acc + c.volume, 0) / 20;
  const volumeConfirmed = lastCandle.volume > avgVolume * 1.1;

  // Confluence
  const rsiMode: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL' = lastRSI > 70 ? 'OVERBOUGHT' : lastRSI < 45 ? 'OVERSOLD' : 'NEUTRAL';
  const macdMode: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = lastMACD ? (lastMACD.MACD > lastMACD.signal ? 'BULLISH' : 'BEARISH') : 'NEUTRAL';
  
  // MACD Crossover Detection
  let macdCrossover: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (lastMACD && prevMACD) {
    if (prevMACD.MACD <= prevMACD.signal && lastMACD.MACD > lastMACD.signal) {
      macdCrossover = 'BULLISH';
    } else if (prevMACD.MACD >= prevMACD.signal && lastMACD.MACD < lastMACD.signal) {
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
  const last50Closes = candles.slice(-50).map(c => c.close);
  const supportLevel = Math.min(...last50Closes);
  const resistanceLevel = Math.max(...last50Closes);
  const nearSupport = lastCandle.close <= supportLevel * 1.02; // within 2% of support
  const nearResistance = lastCandle.close >= resistanceLevel * 0.98; // within 2% of resistance

  const confluenceCount = [
    rsiMode === 'OVERSOLD',
    macdMode === 'BULLISH',
    emaCrossover === 'BULLISH',
    nearSupport,
    macdCrossover === 'BULLISH'
  ].filter(Boolean).length;

  let overall: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  const buySignal = (macdCrossover === 'BULLISH');
  const sellSignal = (macdCrossover === 'BEARISH');

  let score = 0;
  if (buySignal) {
    overall = 'BUY';
    score = 10; 
  } else if (sellSignal) {
    overall = 'SELL';
    score = 10;
  } else {
    // Secondary setup recognition - Not trades, just context
    if (trend !== 'NEUTRAL') score += 1;
    if (volumeConfirmed) score += 1;
    if (macdMode === 'BULLISH') score += 1;
    if (emaCrossover === 'BULLISH') score += 1;
    if (rsiMode === 'OVERSOLD') score += 1;
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
    score: Math.min(10, score)
  };
}
