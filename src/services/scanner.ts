import { fetchBinanceData } from './binance';
import { calculateIndicators, evaluateStrategy, StrategySignal } from './indicators';

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
  shouldContinue?: () => boolean
): Promise<MarketScanResult[]> {
  const results: MarketScanResult[] = [];
  const batchSize = 10; // Increased batch size for faster scanning
  
  for (let i = 0; i < symbols.length; i += batchSize) {
    if (shouldContinue && !shouldContinue()) break;
    if (onProgress) onProgress(i, symbols.length);
    const batch = symbols.slice(i, i + batchSize);
    const batchPromises = batch.map(async (symbol): Promise<MarketScanResult | null> => {
      if (shouldContinue && !shouldContinue()) return null;
      try {
        const candles = await fetchBinanceData(symbol);
        if (candles.length > 50) { 
          const indicators = calculateIndicators(candles);
          const signal = evaluateStrategy(candles, indicators);
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
    
    // Tiny delay to avoid aggressive burst rate limits
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  return results.sort((a, b) => b.signal.score - a.signal.score);
}
