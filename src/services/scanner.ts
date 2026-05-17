import { fetchBinanceData } from './binance';
import { calculateIndicators, evaluateStrategy, StrategyConfig, StrategySignal } from './indicators';

export interface MarketScanResult {
  symbol: string;
  signal: StrategySignal;
  lastPrice: number;
  change24h: number;
  rsi?: number;
  trend?: string;
}

export async function scanMarket(
  symbols: string[],
  onProgress?: (current: number, total: number) => void,
  shouldContinue?: () => boolean,
  strategyConfig?: StrategyConfig,
): Promise<MarketScanResult[]> {
  const results: MarketScanResult[] = [];
  const batchSize = 3;
  const interBatchDelayMs = 550;
  
  for (let i = 0; i < symbols.length; i += batchSize) {
    if (shouldContinue && !shouldContinue()) break;
    if (onProgress) onProgress(i, symbols.length);
    const batch = symbols.slice(i, i + batchSize);
    const batchPromises = batch.map(async (symbol): Promise<MarketScanResult | null> => {
      if (shouldContinue && !shouldContinue()) return null;
      try {
        const candles = await fetchBinanceData(symbol, '1d', 500, { forceBinancePublic: true });
        if (candles.length > 50) {
          // Use closed daily candles for stable crossover signals.
          const signalCandles = candles.length > 2 ? candles.slice(0, -1) : candles;
          const indicators = calculateIndicators(signalCandles, strategyConfig);
          const signal = evaluateStrategy(signalCandles, indicators, strategyConfig);
          const lastCandle = candles[candles.length - 1];
          const prevCandle = candles[candles.length - 2];
          const change24h = ((lastCandle.close - prevCandle.close) / prevCandle.close) * 100;
          
          return {
            symbol,
            signal,
            lastPrice: lastCandle.close,
            change24h,
            rsi: indicators.rsi[indicators.rsi.length - 1],
            trend: signal.trend
          };
        }
      } catch (e) {
        console.error(`Scanner error for ${symbol}:`, e);
      }
      return null;
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults.filter((r): r is MarketScanResult => r !== null));
    if (shouldContinue && !shouldContinue()) break;
    
    // Small jitter avoids synchronized bursts when scanner loops repeatedly.
    const jitterMs = Math.floor(Math.random() * 120);
    await new Promise(resolve => setTimeout(resolve, interBatchDelayMs + jitterMs));
  }
  
  return results.sort((a, b) => b.signal.score - a.signal.score);
}
