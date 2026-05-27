import { fetchAllSymbols, fetchBinanceData } from './src/services/binance.ts';
import { calculateIndicators, evaluateStrategy, DEFAULT_STRATEGY_CONFIG } from './src/services/indicators.ts';

export type AutonomousBotStatus = {
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastMessage: string;
  lastError: string | null;
  cycleCount: number;
};

type AutobotOptions = {
  baseUrl: string;
  liveFuturesQuoteAllowlist: string[];
  scanIntervalSec?: number;
  orderNotionalUsd?: number;
  minSignalScore?: number;
  maxScanSymbols?: number;
};

const DEFAULT_SCAN_INTERVAL_SEC = 40;
const DEFAULT_ORDER_NOTIONAL_USD = 50;
const DEFAULT_MIN_SIGNAL_SCORE = 6;
const DEFAULT_MAX_SCAN_SYMBOLS = 32;

const normalizeLiveFuturesSymbol = (rawSymbol: string): string => {
  const normalized = String(rawSymbol || '').toUpperCase().replace(/[:/]/g, '');
  if (!normalized) return '';
  if (/^(USDT|USDC|BUSD|TUSD|USD)$/.test(normalized)) return '';
  if (normalized.endsWith('USD') && !normalized.endsWith('USDT')) {
    return `${normalized.slice(0, -3)}USDT`;
  }
  return normalized;
};

const buildStatus = (): AutonomousBotStatus => ({
  enabled: false,
  lastRunAt: null,
  nextRunAt: null,
  lastMessage: 'idle',
  lastError: null,
  cycleCount: 0,
});

export function createAutonomousTradingBot(options: AutobotOptions) {
  const scanIntervalMs = Math.max(10000, Number(options.scanIntervalSec || DEFAULT_SCAN_INTERVAL_SEC) * 1000);
  const orderNotionalUsd = Math.max(10, Number(options.orderNotionalUsd || DEFAULT_ORDER_NOTIONAL_USD));
  const minSignalScore = Math.max(0, Number(options.minSignalScore || DEFAULT_MIN_SIGNAL_SCORE));
  const maxScanSymbols = Math.max(5, Number(options.maxScanSymbols || DEFAULT_MAX_SCAN_SYMBOLS));
  const liveQuoteAllowlist = options.liveFuturesQuoteAllowlist.map((q) => String(q || '').toUpperCase()).filter(Boolean);
  const baseUrl = String(options.baseUrl || '').replace(/\/$/, '');

  let enabled = false;
  let nextRunAt: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let status: AutonomousBotStatus = buildStatus();

  const fetchJson = async (url: string, body?: any) => {
    const response = await fetch(url, body ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    } : undefined);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof payload?.message === 'string' ? payload.message : response.statusText;
      throw new Error(`HTTP ${response.status}: ${message}`);
    }
    return payload;
  };

  const updateStatus = (updates: Partial<AutonomousBotStatus>) => {
    status = { ...status, ...updates };
  };

  const setTimer = () => {
    if (timer) clearTimeout(timer);
    if (!enabled) {
      nextRunAt = null;
      updateStatus({ nextRunAt: null });
      return;
    }
    nextRunAt = Date.now() + scanIntervalMs;
    updateStatus({ nextRunAt });
    timer = setTimeout(() => void runCycle(), scanIntervalMs);
  };

  const computePositionMap = (positions: any): Map<string, 'LONG' | 'SHORT'> => {
    const map = new Map<string, 'LONG' | 'SHORT'>();
    if (!positions || typeof positions !== 'object') return map;
    for (const rawKey of Object.keys(positions)) {
      const entry = positions[rawKey] as any;
      const symbol = normalizeLiveFuturesSymbol(String(entry?.symbol || rawKey));
      if (!symbol) continue;
      let side = String(entry?.side || entry?.positionSide || entry?.positionSide || '').toUpperCase();
      if (side !== 'SHORT' && side !== 'LONG') {
        const amt = Number(entry?.contracts ?? entry?.amount ?? entry?.positionAmt ?? 0);
        side = amt < 0 ? 'SHORT' : 'LONG';
      }
      if (symbol) map.set(symbol, side as 'LONG' | 'SHORT');
    }
    return map;
  };

  const runCycle = async () => {
    if (!enabled) return;
    const cycleId = Date.now();
    updateStatus({ lastRunAt: cycleId, lastError: null, cycleCount: status.cycleCount + 1 });

    try {
      const balancePayload = await fetchJson(`${baseUrl}/api/binance/balance?fresh=1`);
      const existingPositions = computePositionMap(balancePayload.positions || {});
      const symbols = await fetchAllSymbols({
        includeSpot: false,
        includeFutures: true,
        fullUniverse: false,
        allowedQuotes: liveQuoteAllowlist,
        forceBinancePublic: true,
        baseUrl,
      });
      const scanSymbols = symbols
        .map((entry) => String(entry.value || '').toUpperCase())
        .slice(0, maxScanSymbols);

      let foundEntry = false;
      let scanCount = 0;
      for (const symbol of scanSymbols) {
        if (!enabled) break;
        const normalized = normalizeLiveFuturesSymbol(symbol);
        if (!normalized) continue;
        if (existingPositions.has(normalized)) continue;

        const candles = await fetchBinanceData(symbol, '1d', 500, { forceBinancePublic: true, baseUrl });
        if (candles.length < 51) continue;

        const signalCandles = candles.slice(0, -1);
        const indicators = calculateIndicators(signalCandles, DEFAULT_STRATEGY_CONFIG);
        const signal = evaluateStrategy(signalCandles, indicators, DEFAULT_STRATEGY_CONFIG);
        const score = Number(signal.score || 0);
        const side = signal.overall;
        const lastPrice = candles[candles.length - 1]?.close || 0;

        scanCount += 1;
        if ((side !== 'BUY' && side !== 'SELL') || score < minSignalScore || !Number.isFinite(lastPrice) || lastPrice <= 0) {
          continue;
        }

        const amount = Math.max(0.000001, orderNotionalUsd / lastPrice);
        const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';
        const payload = {
          symbol,
          side,
          amount,
          positionSide,
        };

        updateStatus({ lastMessage: `Submitting server-side ${side} order for ${symbol} @ ${lastPrice.toFixed(4)} (${score.toFixed(2)})` });
        const orderResponse = await fetchJson(`${baseUrl}/api/binance/order`, payload);
        foundEntry = true;
        updateStatus({ lastMessage: `Server bot submitted ${side} ${symbol} size=${amount.toFixed(6)} (${orderResponse?.status || 'submitted'})` });
        break;
      }

      if (!foundEntry) {
        updateStatus({ lastMessage: `Server bot scanned ${scanCount} symbols and found no live entries.` });
      }
    } catch (error: any) {
      const message = String(error?.message || error || 'Unknown server bot error');
      updateStatus({ lastError: message, lastMessage: `Server bot cycle failed: ${message}` });
    } finally {
      setTimer();
    }
  };

  const start = () => {
    if (enabled) return;
    enabled = true;
    updateStatus({ enabled: true, lastError: null, lastMessage: 'Starting autonomous server bot.' });
    setTimer();
    void runCycle();
  };

  const stop = () => {
    if (!enabled) return;
    enabled = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    nextRunAt = null;
    updateStatus({ enabled: false, nextRunAt: null, lastMessage: 'Autonomous server bot stopped.' });
  };

  const getStatus = (): AutonomousBotStatus => ({ ...status });

  return {
    start,
    stop,
    getStatus,
    isEnabled: () => enabled,
  };
}
