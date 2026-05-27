import { Candle } from './indicators';

type PublicDataSourceKind = 'exchangeInfo' | 'ticker24hr' | 'klines';

type PublicDataSourceSnapshot = Record<PublicDataSourceKind, string>;

const publicDataSourceSnapshot: PublicDataSourceSnapshot = {
  exchangeInfo: 'BINANCE_PUBLIC',
  ticker24hr: 'BINANCE_PUBLIC',
  klines: 'BINANCE_PUBLIC',
};

const failedTickerWebSocketSymbols = new Set<string>();

const rememberPublicDataSource = (kind: PublicDataSourceKind, response: Response) => {
  const source = response.headers.get('x-tradeedge-source');
  const cached = response.headers.get('x-tradeedge-cached') === '1';
  if (!source) return;
  publicDataSourceSnapshot[kind] = cached ? `${source}_CACHE` : source;
};

export function getPublicDataSourceSnapshot(): PublicDataSourceSnapshot {
  return { ...publicDataSourceSnapshot };
}

type FetchKlinesOptions = {
  forceBinancePublic?: boolean;
  baseUrl?: string;
};

const buildRateLimitedError = (retryAt: number) => {
  const error: any = new Error('RATE_LIMITED');
  error.retryAt = retryAt;
  return error;
};

export async function fetchBinanceData(
  symbol: string = 'BTCUSD',
  interval: string = '1d',
  limit: number = 500,
  options?: FetchKlinesOptions,
): Promise<Candle[]> {
  try {
    // Normalize to futures-style symbols (BTCUSDT) so proxy/futures endpoints remain valid.
    const raw = String(symbol || 'BTCUSDT').toUpperCase();
    const targetSymbol = raw === 'BTC'
      ? 'BTCUSDT'
      : (raw.endsWith('USD') && !raw.endsWith('USDT') ? `${raw}T` : raw);
    const forceBinancePublic = options?.forceBinancePublic !== false;
    const sourceQuery = forceBinancePublic ? '&source=binance_public' : '';
    const baseUrl = String(options?.baseUrl || '').replace(/\/$/, '');
    const requestUrl = baseUrl
      ? `${baseUrl}/api/binance/proxy/klines?symbol=${targetSymbol}&interval=${interval}&limit=${limit}${sourceQuery}`
      : `/api/binance/proxy/klines?symbol=${targetSymbol}&interval=${interval}&limit=${limit}${sourceQuery}`;
    const response = await fetch(requestUrl);
    rememberPublicDataSource('klines', response);
    const source = response.headers.get('x-tradeedge-source') || '';
    const retryAt = Number(response.headers.get('x-tradeedge-blocked-until') || '0');
    const data = await response.json();
    if ((source === 'BINANCE_PUBLIC_BLOCKED' || source === 'BINANCE_PUBLIC_FAILED') && retryAt > Date.now()) {
      throw buildRateLimitedError(retryAt);
    }
    if (!Array.isArray(data)) {
      return [];
    }
    
    return data.map((d: any) => ({
      time: d[0] / 1000,
      open: parseFloat(d[1]),
      high: parseFloat(d[2]),
      low: parseFloat(d[3]),
      close: parseFloat(d[4]),
      volume: parseFloat(d[5])
    }));
  } catch (error) {
    if ((error as any)?.message === 'RATE_LIMITED') {
      throw error;
    }
    console.error('Error fetching Binance data:', error);
    return [];
  }
}

export async function fetchLatestPrice(symbol: string): Promise<number | null> {
  try {
    const raw = String(symbol || 'BTCUSDT').toUpperCase();
    const targetSymbol = raw === 'BTC'
      ? 'BTCUSDT'
      : (raw.endsWith('USD') && !raw.endsWith('USDT') ? `${raw}T` : raw);
    const baseUrl = String(options?.baseUrl || '').replace(/\/$/, '');
    const requestUrl = baseUrl
      ? `${baseUrl}/api/binance/price/${targetSymbol}?source=binance_public`
      : `/api/binance/price/${targetSymbol}?source=binance_public`;
    const response = await fetch(requestUrl);
    const data = await response.json();
    const price = Number(data?.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch (error) {
    console.error('Error fetching latest price:', error);
    return null;
  }
}

type FetchAllSymbolsOptions = {
  includeSpot?: boolean;
  includeFutures?: boolean;
  fullUniverse?: boolean;
  allowedQuotes?: string[];
  forceBinancePublic?: boolean;
};

export async function fetchAllSymbols(options?: FetchAllSymbolsOptions): Promise<{ label: string, value: string }[]> {
  try {
    const includeSpot = options?.includeSpot === true;
    const includeFutures = options?.includeFutures !== false;
    const fullUniverse = options?.fullUniverse === true;
    const quoteSource = options?.allowedQuotes && options.allowedQuotes.length > 0
      ? options.allowedQuotes
      : ['USDT', 'USDC'];
    const allowedQuotes = new Set(quoteSource.map(q => String(q || '').toUpperCase()).filter(Boolean));

    const forceBinancePublic = options?.forceBinancePublic !== false;
    const sourceQuery = forceBinancePublic ? '&source=binance_public' : '';
    const baseUrl = String(options?.baseUrl || '').replace(/\/$/, '');
    const requestUrl = baseUrl
      ? `${baseUrl}/api/binance/proxy/exchangeInfo?includeSpot=${includeSpot ? '1' : '0'}&includeFutures=${includeFutures ? '1' : '0'}${sourceQuery}`
      : `/api/binance/proxy/exchangeInfo?includeSpot=${includeSpot ? '1' : '0'}&includeFutures=${includeFutures ? '1' : '0'}${sourceQuery}`;
    const response = await fetch(requestUrl);
    rememberPublicDataSource('exchangeInfo', response);
    const data = await response.json();

    // Rate limited — attach retry time so callers can surface it
    if (data?.status === 'rate_limited') {
      const retryAt = data.bannedUntil || (Date.now() + 60000);
      const err: any = new Error(`RATE_LIMITED`);
      err.retryAt = retryAt;
      throw err;
    }

    const nonTradableBaseAssets = new Set(['USDT', 'USDC', 'BUSD', 'TUSD', 'USDP', 'FDUSD']);
    const symbols = Array.isArray(data?.symbols) ? data.symbols : [];
    const mapped = symbols
      .filter((s: any) => {
        const status = String(s?.status || '').toUpperCase();
        const base = String(s?.baseAsset || '').toUpperCase();
        const quote = String(s?.quoteAsset || '').toUpperCase();
        const symbol = String(s?.symbol || '').toUpperCase();
        const hasAllowedQuote = fullUniverse
          ? true
          : (quote ? allowedQuotes.has(quote) : Array.from(allowedQuotes).some(q => symbol.endsWith(q)));
        const hasTradableBase = !base || !nonTradableBaseAssets.has(base);
        return status === 'TRADING' && hasAllowedQuote && hasTradableBase;
      })
      .map((s: any) => ({
        label: s.symbol,
        value: s.symbol
      }));

    const deduped = new Map<string, { label: string; value: string }>();
    mapped.forEach((entry) => {
      const key = String(entry.value || '').toUpperCase();
      if (!key) return;
      if (!deduped.has(key)) deduped.set(key, { label: key, value: key });
    });

    return Array.from(deduped.values());
  } catch (error: any) {
    if (error?.message === 'RATE_LIMITED') {
      throw error;
    }
    console.error('Error fetching symbols:', error);
    return [];
  }
}
export async function fetchTopSymbolsByVolume(limit: number = 20, options?: { forceBinancePublic?: boolean; baseUrl?: string }): Promise<string[]> {
  try {
    const forceBinancePublic = options?.forceBinancePublic !== false;
    const sourceQuery = forceBinancePublic ? '?source=binance_public' : '';
    const baseUrl = String(options?.baseUrl || '').replace(/\/$/, '');
    const requestUrl = baseUrl
      ? `${baseUrl}/api/binance/proxy/ticker24hr${sourceQuery}`
      : `/api/binance/proxy/ticker24hr${sourceQuery}`;
    const response = await fetch(requestUrl);
    rememberPublicDataSource('ticker24hr', response);
    const data = await response.json();
    return data
      .filter((s: any) => ['USDT', 'USDC'].some(q => String(s?.symbol || '').toUpperCase().endsWith(q)))
      .sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, limit)
      .map((s: any) => s.symbol);
  } catch (error) {
    console.error('Error fetching top symbols:', error);
    return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOTUSDT'];
  }
}

export async function fetchTicker24hStats(options?: { forceBinancePublic?: boolean; baseUrl?: string }): Promise<Map<string, { quoteVolume: number; priceChangePercent: number }>> {
  try {
    const forceBinancePublic = options?.forceBinancePublic !== false;
    const sourceQuery = forceBinancePublic ? '?source=binance_public' : '';
    const baseUrl = String(options?.baseUrl || '').replace(/\/$/, '');
    const requestUrl = baseUrl
      ? `${baseUrl}/api/binance/proxy/ticker24hr${sourceQuery}`
      : `/api/binance/proxy/ticker24hr${sourceQuery}`;
    const response = await fetch(requestUrl);
    rememberPublicDataSource('ticker24hr', response);
    const data = await response.json();
    if (!Array.isArray(data)) return new Map();

    const stats = new Map<string, { quoteVolume: number; priceChangePercent: number }>();
    data.forEach((row: any) => {
      const symbol = String(row?.symbol || '').toUpperCase();
      if (!symbol) return;
      stats.set(symbol, {
        quoteVolume: Number.parseFloat(String(row?.quoteVolume || '0')) || 0,
        priceChangePercent: Number.parseFloat(String(row?.priceChangePercent || row?.price24hPcnt || '0')) || 0,
      });
    });
    return stats;
  } catch (error) {
    console.error('Error fetching ticker stats:', error);
    return new Map();
  }
}

export type LiveAccountAuditTrade = {
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
  quoteQty: number;
  realizedPnl: number;
  commission: number;
  commissionAsset: string;
  time: number;
  orderId: string;
};

export type LiveAccountAuditIncome = {
  symbol: string;
  asset: string;
  incomeType: string;
  income: number;
  info: string;
  time: number;
  tranId: string;
  tradeId: string;
};

export type LiveAccountAuditSummary = {
  realizedPnl: number;
  commission: number;
  funding: number;
  transfer: number;
  other: number;
  netIncome: number;
  byType: Record<string, number>;
};

export type LiveAccountAuditSnapshot = {
  exchange: string;
  startTime: number;
  endTime: number;
  routeHealth: {
    trades: string;
    incomes: string;
  };
  trades: LiveAccountAuditTrade[];
  incomes: LiveAccountAuditIncome[];
  summary: LiveAccountAuditSummary;
};

export async function fetchLiveAccountAudit(options?: { startTime?: number; endTime?: number; days?: number; limit?: number }): Promise<LiveAccountAuditSnapshot> {
  const params = new URLSearchParams();
  if (Number.isFinite(options?.startTime)) params.set('startTime', String(options?.startTime));
  if (Number.isFinite(options?.endTime)) params.set('endTime', String(options?.endTime));
  if (Number.isFinite(options?.days)) params.set('days', String(options?.days));
  if (Number.isFinite(options?.limit)) params.set('limit', String(options?.limit));

  const response = await fetch(`/api/binance/account-audit?${params.toString()}`);
  const data = await response.json();
  if (!response.ok || data?.status !== 'success') {
    throw new Error(String(data?.message || `Account audit failed with ${response.status}`));
  }

  return {
    exchange: String(data.exchange || 'binance'),
    startTime: Number(data.startTime || 0),
    endTime: Number(data.endTime || 0),
    routeHealth: {
      trades: String(data?.routeHealth?.trades || 'UNKNOWN'),
      incomes: String(data?.routeHealth?.incomes || 'UNKNOWN'),
    },
    trades: Array.isArray(data.trades) ? data.trades : [],
    incomes: Array.isArray(data.incomes) ? data.incomes : [],
    summary: {
      realizedPnl: Number(data?.summary?.realizedPnl || 0),
      commission: Number(data?.summary?.commission || 0),
      funding: Number(data?.summary?.funding || 0),
      transfer: Number(data?.summary?.transfer || 0),
      other: Number(data?.summary?.other || 0),
      netIncome: Number(data?.summary?.netIncome || 0),
      byType: typeof data?.summary?.byType === 'object' && data.summary.byType ? data.summary.byType : {},
    },
  };
}

export function subscribeToTicker(
  symbol: string,
  onUpdate: (price: number) => void,
  options?: { preferWebSocket?: boolean }
) {
  const normalizedSymbol = String(symbol || '').toUpperCase();
  const preferWebSocket = options?.preferWebSocket === true && !failedTickerWebSocketSymbols.has(normalizedSymbol);
  const isBinanceSymbol = (normalizedSymbol.endsWith('USDT') || normalizedSymbol.endsWith('USDC')) && !normalizedSymbol.includes('/');

  const startPolling = () => {
    console.log(`[TradeEdge] Using polling for ${normalizedSymbol} node sync...`);
    const interval = setInterval(async () => {
      try {
        const resp = await fetch(`/api/binance/price/${normalizedSymbol}?source=binance_public`);
        const data = await resp.json();
        if (data.status === 'success' && data.price) {
          onUpdate(parseFloat(data.price));
        }
      } catch {
        // Silent fail to avoid log spam
      }
    }, 3000);
    return () => clearInterval(interval);
  };

  if (preferWebSocket && isBinanceSymbol) {
    const ws = new WebSocket(`wss://fstream.binance.com/ws/${normalizedSymbol.toLowerCase()}@ticker`);
    let fallbackCleanup: (() => void) | null = null;
    let socketOpened = false;

    const fallbackToPolling = () => {
      if (fallbackCleanup) return;
      failedTickerWebSocketSymbols.add(normalizedSymbol);
      fallbackCleanup = startPolling();
    };

    ws.onopen = () => {
      socketOpened = true;
    };
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      onUpdate(parseFloat(data.c));
    };
    ws.onerror = () => {
      fallbackToPolling();
    };
    ws.onclose = () => {
      if (!socketOpened) {
        fallbackToPolling();
      }
    };
    return () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      fallbackCleanup?.();
    };
  } else {
    // Gemini / Generic Polling Fallback
    return startPolling();
  }
}
