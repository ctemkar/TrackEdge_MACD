import { Candle } from './indicators';

type FetchKlinesOptions = {
  forceBinancePublic?: boolean;
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
    const forceBinancePublic = options?.forceBinancePublic === true;
    const sourceQuery = forceBinancePublic ? '&source=binance_public' : '';
    const response = await fetch(`/api/binance/proxy/klines?symbol=${targetSymbol}&interval=${interval}&limit=${limit}${sourceQuery}`);
    const data = await response.json();
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
    console.error('Error fetching Binance data:', error);
    return [];
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

    const forceBinancePublic = options?.forceBinancePublic === true;
    const sourceQuery = forceBinancePublic ? '&source=binance_public' : '';
    const response = await fetch(`/api/binance/proxy/exchangeInfo?includeSpot=${includeSpot ? '1' : '0'}&includeFutures=${includeFutures ? '1' : '0'}${sourceQuery}`);
    const data = await response.json();

    // Rate limited — attach retry time so callers can surface it
    if (data?.status === 'rate_limited') {
      const retryAt = data.bannedUntil || (Date.now() + 60000);
      const err: any = new Error(`RATE_LIMITED`);
      err.retryAt = retryAt;
      throw err;
    }

    const symbols = Array.isArray(data?.symbols) ? data.symbols : [];
    const mapped = symbols
      .filter((s: any) => {
        const status = String(s?.status || '').toUpperCase();
        const quote = String(s?.quoteAsset || '').toUpperCase();
        const symbol = String(s?.symbol || '').toUpperCase();
        const hasAllowedQuote = fullUniverse
          ? true
          : (quote ? allowedQuotes.has(quote) : Array.from(allowedQuotes).some(q => symbol.endsWith(q)));
        return status === 'TRADING' && hasAllowedQuote;
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
export async function fetchTopSymbolsByVolume(limit: number = 20, options?: { forceBinancePublic?: boolean }): Promise<string[]> {
  try {
    const forceBinancePublic = options?.forceBinancePublic === true;
    const sourceQuery = forceBinancePublic ? '?source=binance_public' : '';
    const response = await fetch(`/api/binance/proxy/ticker24hr${sourceQuery}`);
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

export async function fetchTicker24hStats(options?: { forceBinancePublic?: boolean }): Promise<Map<string, { quoteVolume: number; priceChangePercent: number }>> {
  try {
    const forceBinancePublic = options?.forceBinancePublic === true;
    const sourceQuery = forceBinancePublic ? '?source=binance_public' : '';
    const response = await fetch(`/api/binance/proxy/ticker24hr${sourceQuery}`);
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

export function subscribeToTicker(
  symbol: string,
  onUpdate: (price: number) => void,
  options?: { preferWebSocket?: boolean }
) {
  const preferWebSocket = options?.preferWebSocket === true;
  const isBinanceSymbol = (symbol.endsWith('USDT') || symbol.endsWith('USDC')) && !symbol.includes('/');

  if (preferWebSocket && isBinanceSymbol) {
    const ws = new WebSocket(`wss://fstream.binance.com/ws/${symbol.toLowerCase()}@ticker`);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      onUpdate(parseFloat(data.c));
    };
    return () => ws.close();
  } else {
    // Gemini / Generic Polling Fallback
    console.log(`[TradeEdge] Using polling for ${symbol} node sync...`);
    const interval = setInterval(async () => {
      try {
        const resp = await fetch(`/api/binance/price/${symbol}`);
        const data = await resp.json();
        if (data.status === 'success' && data.price) {
          onUpdate(parseFloat(data.price));
        }
      } catch (e) {
        // Silent fail to avoid log spam
      }
    }, 3000);
    return () => clearInterval(interval);
  }
}
