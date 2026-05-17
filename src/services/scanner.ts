import { fetchBinanceData, fetchTicker24hStats } from './binance';
import { calculateIndicators, evaluateStrategy, StrategyConfig, StrategySignal } from './indicators';

export interface MarketScanResult {
  symbol: string;
  signal: StrategySignal;
  lastPrice: number;
  change24h: number;
  macdSpread?: number;
  quoteVolume?: number;
  rsi?: number;
  trend?: string;
  priorityRank?: number;
}

function computeProfitabilityRank(result: MarketScanResult): number {
  const signalActive = result.signal.overall === 'BUY' || result.signal.overall === 'SELL';
  if (!signalActive) return -Infinity;

  const macdComponent = Math.min(20, Math.log10(1 + Math.max(0, result.macdSpread || 0) * 100000));
  const volumeComponent = Math.min(12, Math.log10(1 + Math.max(0, result.quoteVolume || 0)));
  const trendAligned =
    (result.signal.overall === 'BUY' && result.trend === 'UP') ||
    (result.signal.overall === 'SELL' && result.trend === 'DOWN');
  const trendComponent = trendAligned ? 4 : 0;
  const moveMagnitude = Math.abs(result.change24h || 0);
  const momentumComponent = Math.min(5, moveMagnitude / 3);
  const spikePenalty = moveMagnitude > 18 ? Math.min(6, (moveMagnitude - 18) / 2) : 0;

  return macdComponent + volumeComponent + trendComponent + momentumComponent - spikePenalty;
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
  const tickerStats = await fetchTicker24hStats({ forceBinancePublic: true });
  
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
          const lastMacdPoint = indicators.macd[indicators.macd.length - 1];
          const change24h = ((lastCandle.close - prevCandle.close) / prevCandle.close) * 100;
          const macdSpread = lastMacdPoint
            ? Math.abs((lastMacdPoint.MACD || 0) - (lastMacdPoint.signal || 0))
            : 0;
          const tickerStat = tickerStats.get(symbol.toUpperCase());
          
          const baseResult: MarketScanResult = {
            symbol,
            signal,
            lastPrice: lastCandle.close,
            change24h,
            macdSpread,
            quoteVolume: tickerStat?.quoteVolume || 0,
            rsi: indicators.rsi[indicators.rsi.length - 1],
            trend: signal.trend
          };

          return {
            ...baseResult,
            priorityRank: computeProfitabilityRank(baseResult),
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
  
  return results.sort((a, b) => {
    const profitabilityDelta = (b.priorityRank || 0) - (a.priorityRank || 0);
    if (profitabilityDelta !== 0) return profitabilityDelta;

    const scoreDelta = b.signal.score - a.signal.score;
    if (scoreDelta !== 0) return scoreDelta;

    const macdSpreadDelta = (b.macdSpread || 0) - (a.macdSpread || 0);
    if (macdSpreadDelta !== 0) return macdSpreadDelta;

    return Math.abs(b.change24h) - Math.abs(a.change24h);
  });
}
