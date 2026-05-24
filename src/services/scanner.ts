import { fetchBinanceData, fetchTicker24hStats } from './binance';
import { Candle } from './indicators';
import { calculateIndicators, evaluateStrategy, StrategyConfig, StrategySignal } from './indicators';

export type ScanTickerStats = Map<string, { quoteVolume: number; priceChangePercent: number }>;

export interface MarketScanResult {
  symbol: string;
  signal: StrategySignal;
  lastPrice: number;
  change24h: number;
  macdSpread?: number;
  macdHistogram?: number;
  macdHistogramDelta?: number;
  quoteVolume?: number;
  rsi?: number;
  trend?: string;
  priorityRank?: number;
}

type ScanMarketOptions = {
  shortlistLimit?: number;
  prioritySymbols?: string[];
  onRateLimit?: (retryAt: number) => void;
  batchSize?: number;
  interBatchDelayMs?: number;
  onResultComputed?: (result: MarketScanResult) => void | Promise<void>;
  shortlistExclusionReason?: string;
  tickerStats?: ScanTickerStats;
  onSelectionComputed?: (summary: {
    analyzedSymbols: string[];
    excludedSymbols: Array<{ symbol: string; reason: string }>;
  }) => void;
  onUnavailableComputed?: (summary: {
    entries: Array<{ symbol: string; reason: string }>;
    insufficientHistory: number;
    otherUnavailable: number;
  }) => void;
};

const MIN_SCAN_CANDLE_COUNT = 51;
const MAX_SCAN_FETCH_ATTEMPTS = 3;
const SCAN_FETCH_RETRY_DELAY_MS = 180;
const LOW_HISTORY_SYMBOL_TTL_MS = 6 * 60 * 60 * 1000;

const lowHistorySymbols = new Map<string, { until: number; candles: number }>();

export function getLowHistorySnapshot(symbol: string): { until: number; candles: number } | null {
  const normalized = String(symbol || '').toUpperCase();
  if (!normalized) return null;
  const snapshot = lowHistorySymbols.get(normalized);
  if (!snapshot) return null;
  if (snapshot.until <= Date.now()) {
    lowHistorySymbols.delete(normalized);
    return null;
  }
  return snapshot;
}

function markLowHistorySymbol(symbol: string, candles: number) {
  const normalized = String(symbol || '').toUpperCase();
  if (!normalized) return;
  lowHistorySymbols.set(normalized, {
    until: Date.now() + LOW_HISTORY_SYMBOL_TTL_MS,
    candles: Math.max(0, candles),
  });
}

function getDirectionalSignalStrength(signal: StrategySignal): number {
  if (signal.overall === 'SELL') return 10 - signal.score;
  if (signal.overall === 'BUY') return signal.score;
  return Math.abs(signal.score - 5);
}

function computeProfitabilityRank(result: MarketScanResult): number {
  const signalActive = result.signal.overall === 'BUY' || result.signal.overall === 'SELL';
  if (!signalActive) return -Infinity;

  const macdComponent = Math.min(20, Math.log10(1 + Math.max(0, result.macdSpread || 0) * 100000));
  const isSell = result.signal.overall === 'SELL';
  const histogramAligned =
    (result.signal.overall === 'BUY' && (result.macdHistogram || 0) > 0 && (result.macdHistogramDelta || 0) >= 0) ||
    (result.signal.overall === 'SELL' && (result.macdHistogram || 0) < 0 && (result.macdHistogramDelta || 0) <= 0);
  const histogramComponent = histogramAligned
    ? Math.min(8, Math.log10(1 + Math.abs(result.macdHistogram || 0) * 100000) * 4)
    : 0;
  const volumeComponent = Math.min(12, Math.log10(1 + Math.max(0, result.quoteVolume || 0)));
  const trendAligned =
    (result.signal.overall === 'BUY' && result.trend === 'UP') ||
    (result.signal.overall === 'SELL' && result.trend === 'DOWN');
  const trendComponent = trendAligned ? 4 : 0;
  const directionalMove = Number(result.change24h || 0);
  const favorableMove = isSell ? Math.max(0, -directionalMove) : Math.max(0, directionalMove);
  const moveMagnitude = Math.abs(directionalMove);
  const momentumComponent = Math.min(5, favorableMove / 3);
  const spikePenalty = moveMagnitude > 18 ? Math.min(6, (moveMagnitude - 18) / 2) : 0;
  const rsiValue = Number.isFinite(Number(result.rsi)) ? Number(result.rsi) : 50;
  const exhaustionPenalty = isSell
    ? Math.max(
        favorableMove > 6 ? Math.min(4, (favorableMove - 6) / 1.5) : 0,
        rsiValue < 38 ? Math.min(3, (38 - rsiValue) / 4) : 0,
      )
    : Math.max(
        favorableMove > 6 ? Math.min(4, (favorableMove - 6) / 1.5) : 0,
        rsiValue > 62 ? Math.min(3, (rsiValue - 62) / 4) : 0,
      );

  return macdComponent + histogramComponent + volumeComponent + trendComponent + momentumComponent - spikePenalty - exhaustionPenalty;
}

async function fetchScanCandlesWithRetry(symbol: string): Promise<Candle[]> {
  let lastError: unknown = null;
  let lastCandleCount = 0;

  for (let attempt = 1; attempt <= MAX_SCAN_FETCH_ATTEMPTS; attempt++) {
    try {
      const candles = await fetchBinanceData(symbol, '1d', 500, { forceBinancePublic: true });
      if (candles.length >= MIN_SCAN_CANDLE_COUNT) {
        lowHistorySymbols.delete(String(symbol || '').toUpperCase());
        return candles;
      }

      lastCandleCount = candles.length;
      lastError = new Error(`INSUFFICIENT_CANDLES:${candles.length}`);
    } catch (error) {
      if ((error as any)?.message === 'RATE_LIMITED') {
        throw error;
      }
      lastError = error;
    }

    if (attempt < MAX_SCAN_FETCH_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, SCAN_FETCH_RETRY_DELAY_MS * attempt));
    }
  }

  if (lastError) {
    markLowHistorySymbol(symbol, lastCandleCount);
    console.warn(`[TradeEdge] Scanner exhausted fetch retries for ${symbol}:`, lastError);
  }

  return [];
}

export async function scanMarket(
  symbols: string[],
  onProgress?: (current: number, total: number) => void,
  shouldContinue?: () => boolean,
  strategyConfig?: StrategyConfig,
  options?: ScanMarketOptions,
): Promise<MarketScanResult[]> {
  const results: MarketScanResult[] = [];
  const unavailableEntries: Array<{ symbol: string; reason: string }> = [];
  const preShortlistExcluded: Array<{ symbol: string; reason: string }> = [];
  const batchSize = Math.max(1, Math.min(5, options?.batchSize || 3));
  const interBatchDelayMs = Math.max(250, options?.interBatchDelayMs || 550);
  let rateLimitedUntil = 0;
  const tickerStats = options?.tickerStats || await fetchTicker24hStats({ forceBinancePublic: true });
  const prioritySymbols = new Set((options?.prioritySymbols || []).map(symbol => String(symbol || '').toUpperCase()).filter(Boolean));
  const shortlistLimit = Math.max(prioritySymbols.size, Math.min(symbols.length, options?.shortlistLimit || symbols.length));
  const shortlistExclusionReason = options?.shortlistExclusionReason || 'not shortlisted this cycle';
  const eligibleSymbols = [...symbols].filter((symbol) => {
    const normalized = symbol.toUpperCase();
    if (prioritySymbols.has(normalized)) {
      return true;
    }

    const lowHistorySnapshot = getLowHistorySnapshot(normalized);
    if (lowHistorySnapshot) {
      preShortlistExcluded.push({
        symbol,
        reason: `insufficient candle history (${lowHistorySnapshot.candles}/${MIN_SCAN_CANDLE_COUNT})`,
      });
      return false;
    }

    const stats = tickerStats.get(normalized);
    const quoteVolume = Math.max(0, stats?.quoteVolume || 0);
    if (quoteVolume > 0) {
      return true;
    }

    preShortlistExcluded.push({
      symbol,
      reason: 'no recent ticker volume',
    });
    return false;
  });

  const rankedSymbols = eligibleSymbols.sort((a, b) => {
    const aPriority = prioritySymbols.has(a.toUpperCase()) ? 1 : 0;
    const bPriority = prioritySymbols.has(b.toUpperCase()) ? 1 : 0;
    if (aPriority !== bPriority) return bPriority - aPriority;

    const aStats = tickerStats.get(a.toUpperCase());
    const bStats = tickerStats.get(b.toUpperCase());
    const aVolume = Math.max(0, aStats?.quoteVolume || 0);
    const bVolume = Math.max(0, bStats?.quoteVolume || 0);
    if (aVolume !== bVolume) return bVolume - aVolume;

    const aMove = Math.abs(aStats?.priceChangePercent || 0);
    const bMove = Math.abs(bStats?.priceChangePercent || 0);
    return bMove - aMove;
  });
  const symbolsToAnalyze = rankedSymbols.slice(0, shortlistLimit);
  options?.onSelectionComputed?.({
    analyzedSymbols: symbolsToAnalyze,
    excludedSymbols: [
      ...preShortlistExcluded,
      ...rankedSymbols.slice(shortlistLimit).map(symbol => ({
        symbol,
        reason: shortlistExclusionReason,
      })),
    ],
  });
  const canContinue = () => rateLimitedUntil <= Date.now() && (!shouldContinue || shouldContinue());
  
  for (let i = 0; i < symbolsToAnalyze.length; i += batchSize) {
    if (!canContinue()) break;
    if (onProgress) onProgress(i, symbolsToAnalyze.length);
    const batch = symbolsToAnalyze.slice(i, i + batchSize);
    const batchPromises = batch.map(async (symbol): Promise<MarketScanResult | null> => {
      if (!canContinue()) return null;
      try {
        const candles = await fetchScanCandlesWithRetry(symbol);
        if (candles.length >= MIN_SCAN_CANDLE_COUNT) {
          // Use closed daily candles for stable crossover signals.
          const signalCandles = candles.length > 2 ? candles.slice(0, -1) : candles;
          const indicators = calculateIndicators(signalCandles, strategyConfig);
          const signal = evaluateStrategy(signalCandles, indicators, strategyConfig);
          const lastCandle = candles[candles.length - 1];
          const prevCandle = candles[candles.length - 2];
          const lastMacdPoint = indicators.macd[indicators.macd.length - 1];
          const prevMacdPoint = indicators.macd[indicators.macd.length - 2];
          const change24h = ((lastCandle.close - prevCandle.close) / prevCandle.close) * 100;
          const macdSpread = lastMacdPoint
            ? Math.abs((lastMacdPoint.MACD || 0) - (lastMacdPoint.signal || 0))
            : 0;
          const macdHistogram = lastMacdPoint?.histogram ?? 0;
          const macdHistogramDelta = macdHistogram - (prevMacdPoint?.histogram ?? 0);
          const tickerStat = tickerStats.get(symbol.toUpperCase());
          
          const baseResult: MarketScanResult = {
            symbol,
            signal,
            lastPrice: lastCandle.close,
            change24h,
            macdSpread,
            macdHistogram,
            macdHistogramDelta,
            quoteVolume: tickerStat?.quoteVolume || 0,
            rsi: indicators.rsi[indicators.rsi.length - 1],
            trend: signal.trend
          };

          return {
            ...baseResult,
            priorityRank: computeProfitabilityRank(baseResult),
          };
        }

        const lowHistorySnapshot = getLowHistorySnapshot(symbol);
        unavailableEntries.push({
          symbol,
          reason: lowHistorySnapshot
            ? `insufficient candle history (${lowHistorySnapshot.candles}/${MIN_SCAN_CANDLE_COUNT})`
            : 'no usable scan result',
        });
      } catch (e) {
        const retryAt = Number((e as any)?.retryAt || 0);
        if (retryAt > Date.now()) {
          rateLimitedUntil = Math.max(rateLimitedUntil, retryAt);
          options?.onRateLimit?.(retryAt);
          return null;
        }
        unavailableEntries.push({
          symbol,
          reason: 'scan fetch failed',
        });
        console.error(`Scanner error for ${symbol}:`, e);
      }
      return null;
    });

    const batchResults = await Promise.all(batchPromises);
    batchResults.forEach((result) => {
      if (!result) return;
      void Promise.resolve(options?.onResultComputed?.(result)).catch((error) => {
        console.warn('[TradeEdge] onResultComputed callback failed:', error);
      });
    });
    results.push(...batchResults.filter((r): r is MarketScanResult => r !== null));
    if (!canContinue()) break;
    
    // Small jitter avoids synchronized bursts when scanner loops repeatedly.
    const jitterMs = Math.floor(Math.random() * 120);
    await new Promise(resolve => setTimeout(resolve, interBatchDelayMs + jitterMs));
  }

  options?.onUnavailableComputed?.({
    entries: unavailableEntries,
    insufficientHistory: unavailableEntries.filter((entry) => entry.reason.startsWith('insufficient candle history')).length,
    otherUnavailable: unavailableEntries.filter((entry) => !entry.reason.startsWith('insufficient candle history')).length,
  });
  
  return results.sort((a, b) => {
    const profitabilityDelta = (b.priorityRank || 0) - (a.priorityRank || 0);
    if (profitabilityDelta !== 0) return profitabilityDelta;

    const scoreDelta = getDirectionalSignalStrength(b.signal) - getDirectionalSignalStrength(a.signal);
    if (scoreDelta !== 0) return scoreDelta;

    const macdSpreadDelta = (b.macdSpread || 0) - (a.macdSpread || 0);
    if (macdSpreadDelta !== 0) return macdSpreadDelta;

    return Math.abs(b.change24h) - Math.abs(a.change24h);
  });
}
