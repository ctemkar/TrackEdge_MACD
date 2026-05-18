import { Candle, calculateIndicators, DEFAULT_STRATEGY_CONFIG, evaluateStrategy, StrategyConfig } from './indicators';

export interface BacktestResult {
  symbol: string;
  totalPnL: number;
  totalPnLPercent: number;
  winRate: number;
  maxDrawdown: number;
  trades: BacktestTrade[];
  equityCurve: { time: number; value: number }[];
}

export interface BacktestTrade {
  type: 'BUY' | 'SELL';
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  profit: number;
  profitPercent: number;
  reason: string;
}

export async function fetchHistoricalData(
  symbol: string,
  interval: string = '15m',
  limit: number = 1000
): Promise<Candle[]> {
  try {
    const response = await fetch(`/api/binance/proxy/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
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
    console.error('Error fetching historical Binance data:', error);
    return [];
  }
}

export function runBacktest(
  candles: Candle[],
  initialBalance: number = 1000,
  stopLossPercent: number = 2,
  takeProfitPercent: number = 5,
  strategyConfig: StrategyConfig = DEFAULT_STRATEGY_CONFIG
): BacktestResult {
  let balance = initialBalance;
  let currentPosition: { entryPrice: number; entryTime: number; amount: number } | null = null;
  const trades: BacktestTrade[] = [];
  const equityCurve: { time: number; value: number }[] = [];
  const requiredWarmup = Math.max(
    200,
    strategyConfig.trendSmaPeriod,
    strategyConfig.macdSlowPeriod + strategyConfig.macdSignalPeriod,
    strategyConfig.rsiPeriod,
    strategyConfig.emaSlowPeriod,
    strategyConfig.supportLookback,
    strategyConfig.volumeLookback,
  );
  
  if (candles.length < requiredWarmup) {
    return {
      symbol: '',
      totalPnL: 0,
      totalPnLPercent: 0,
      winRate: 0,
      maxDrawdown: 0,
      trades: [],
      equityCurve: []
    };
  }

  for (let i = requiredWarmup; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const indicators = calculateIndicators(window, strategyConfig);
    const signal = evaluateStrategy(window, indicators, strategyConfig);
    const currentCandle = candles[i];

    // Manage current position
    if (currentPosition) {
      const pnlPercent = ((currentCandle.close - currentPosition.entryPrice) / currentPosition.entryPrice) * 100;
      
      // Exit conditions: Sell Signal, Stop Loss, or Take Profit
      const shouldExit = signal.exitSignal === 'EXIT_LONG' || pnlPercent <= -stopLossPercent || pnlPercent >= takeProfitPercent;

      if (shouldExit) {
        const profit = (currentCandle.close - currentPosition.entryPrice) * currentPosition.amount;
        balance += profit;
        
        trades.push({
          type: 'BUY', // Entry was buy
          entryTime: currentPosition.entryTime,
          exitTime: currentCandle.time,
          entryPrice: currentPosition.entryPrice,
          exitPrice: currentCandle.close,
          profit: profit,
          profitPercent: pnlPercent,
          reason: signal.exitSignal === 'EXIT_LONG' ? 'MACD Exit Override' : (pnlPercent <= -stopLossPercent ? 'Stop Loss' : 'Take Profit')
        });
        
        currentPosition = null;
      }
    } else {
      // Entry condition
      if (signal.overall === 'BUY') {
        const amount = balance / currentCandle.close;
        currentPosition = {
          entryPrice: currentCandle.close,
          entryTime: currentCandle.time,
          amount: amount
        };
      }
    }

    equityCurve.push({
      time: currentCandle.time,
      value: currentPosition 
        ? balance + (currentCandle.close - currentPosition.entryPrice) * currentPosition.amount
        : balance
    });
  }

  // Metrics
  const totalPnL = balance - initialBalance;
  const totalPnLPercent = (totalPnL / initialBalance) * 100;
  const winningTrades = trades.filter(t => t.profit > 0);
  const winRate = trades.length > 0 ? (winningTrades.length / trades.length) * 100 : 0;

  // Max Drawdown
  let peak = initialBalance;
  let maxDrawdown = 0;
  equityCurve.forEach(p => {
    if (p.value > peak) peak = p.value;
    const dd = (peak - p.value) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  });

  return {
    symbol: '', // to be set by caller
    totalPnL,
    totalPnLPercent,
    winRate,
    maxDrawdown: maxDrawdown * 100,
    trades,
    equityCurve
  };
}
