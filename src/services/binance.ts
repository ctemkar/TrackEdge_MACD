import { Candle } from './indicators';

export async function fetchBinanceData(symbol: string = 'BTCUSD', interval: string = '15m', limit: number = 500): Promise<Candle[]> {
  try {
    // If symbol is passed without quote, default to USD for Gemini compatibility
    const targetSymbol = symbol === 'BTC' ? 'BTCUSD' : symbol;
    const response = await fetch(`/api/binance/proxy/klines?symbol=${targetSymbol}&interval=${interval}&limit=${limit}`);
    const data = await response.json();
    
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

export async function fetchAllSymbols(): Promise<{ label: string, value: string }[]> {
  try {
    const response = await fetch('/api/binance/proxy/exchangeInfo');
    const data = await response.json();
    return data.symbols
      .filter((s: any) => s.status === 'TRADING')
      .map((s: any) => ({
        label: s.symbol,
        value: s.symbol
      }));
  } catch (error) {
    console.error('Error fetching symbols:', error);
    return [];
  }
}
export async function fetchTopSymbolsByVolume(limit: number = 20): Promise<string[]> {
  try {
    const response = await fetch('/api/binance/proxy/ticker24hr');
    const data = await response.json();
    return data
      .filter((s: any) => ['USDT', 'USD', 'GUSD', 'USDC', 'DAI'].some(q => s.symbol.endsWith(q)))
      .sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, limit)
      .map((s: any) => s.symbol);
  } catch (error) {
    console.error('Error fetching top symbols:', error);
    return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOTUSDT'];
  }
}
export function subscribeToTicker(symbol: string, onUpdate: (price: number) => void) {
  const isBinanceSymbol = symbol.endsWith('USDT') && !symbol.includes('/');
  
  if (isBinanceSymbol) {
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@ticker`);
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
