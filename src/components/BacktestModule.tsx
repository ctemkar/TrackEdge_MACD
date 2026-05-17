import React, { useState, useEffect } from 'react';
import { Play, LineChart, TrendingUp, TrendingDown, History, Info, ChevronDown, ChevronUp, AlertCircle, Calendar } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { fetchHistoricalData, runBacktest, BacktestResult, BacktestTrade } from '../services/backtest';
import { Candle, StrategyConfig } from '../services/indicators';

interface BacktestModuleProps {
  symbol: string;
  availableSymbols: { label: string, value: string }[];
  strategyConfig: StrategyConfig;
}

export function BacktestModule({ symbol: initialSymbol, availableSymbols, strategyConfig }: BacktestModuleProps) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [interval, setInterval] = useState('15m');
  const [limit, setLimit] = useState(1000);
  const [stopLoss, setStopLoss] = useState(2);
  const [takeProfit, setTakeProfit] = useState(6);
  const [isBacktesting, setIsBacktesting] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTrades, setShowTrades] = useState(false);

  const intervals = ['5m', '15m', '1h', '4h', '1d'];

  const handleRunBacktest = async () => {
    setIsBacktesting(true);
    setError(null);
    setResult(null);

    try {
      const candles = await fetchHistoricalData(symbol, interval, limit);
      if (candles.length < 200) {
        throw new Error('Not enough historical data for a valid simulation (minimum 200 candles required).');
      }

      const backtestResult = runBacktest(candles, 1000, stopLoss, takeProfit, strategyConfig);
      setResult({ ...backtestResult, symbol });
    } catch (e: any) {
      setError(e.message || 'An error occurred during backtesting.');
    } finally {
      setIsBacktesting(false);
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString();
  };

  const renderEquityCurve = () => {
    if (!result || result.equityCurve.length < 2) return null;

    const width = 800;
    const height = 200;
    const padding = 20;

    const values = result.equityCurve.map(p => p.value);
    const min = Math.min(...values) * 0.98;
    const max = Math.max(...values) * 1.02;
    const range = max - min;

    const points = result.equityCurve.map((p, i) => {
      const x = (i / (result.equityCurve.length - 1)) * (width - padding * 2) + padding;
      const y = height - ((p.value - min) / range) * (height - padding * 2) - padding;
      return `${x},${y}`;
    }).join(' ');

    return (
      <div className="bg-white/5 p-6 rounded-xl border border-white/10 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-white flex items-center gap-2">
            <LineChart className="w-4 h-4 text-blue-400" />
            Performance Timeline (Equity Curve)
          </h3>
          <div className="flex gap-4 text-[10px] font-mono text-gray-500 uppercase">
            <span className="flex items-center gap-1"><div className="w-2 h-2 bg-blue-500 rounded-sm"></div> Balance</span>
            <span>Range: ${min.toFixed(0)} - ${max.toFixed(0)}</span>
          </div>
        </div>
        <div className="relative w-full h-[200px]">
          <svg 
            viewBox={`0 0 ${width} ${height}`} 
            className="w-full h-full overflow-visible drop-shadow-2xl"
            preserveAspectRatio="none"
          >
            {/* Grid Lines */}
            <line x1={padding} y1={padding} x2={padding} y2={height-padding} stroke="currentColor" className="text-white/10" strokeWidth="1" />
            <line x1={padding} y1={height-padding} x2={width-padding} y2={height-padding} stroke="currentColor" className="text-white/10" strokeWidth="1" />
            
            {/* Drawdown Area (Optional if we want to show it more clearly) */}
            
            {/* The Path */}
            <polyline
              fill="none"
              stroke="#3b82f6"
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              points={points}
              className="drop-shadow-[0_0_8px_rgba(59,130,246,0.3)]"
            />
            
            {/* Dots for Trades */}
            {result.trades.map((trade, i) => {
              const tradeIndex = result.equityCurve.findIndex(p => p.time === trade.exitTime);
              if (tradeIndex === -1) return null;
              const x = (tradeIndex / (result.equityCurve.length - 1)) * (width - padding * 2) + padding;
              const y = height - ((result.equityCurve[tradeIndex].value - min) / range) * (height - padding * 2) - padding;
              return (
                <circle 
                  key={i} 
                  cx={x} 
                  cy={y} 
                  r="3" 
                  fill={trade.profit > 0 ? '#10b981' : '#ef4444'} 
                  className="opacity-80"
                />
              );
            })}
          </svg>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Backtest Controls */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 bg-white/5 p-4 rounded-xl border border-white/10">
        <div className="space-y-2">
          <label className="text-xs text-gray-400 font-medium flex items-center gap-2">
            <Info className="w-3 h-3" /> Trading Pair
          </label>
          <select 
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {availableSymbols.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-xs text-gray-400 font-medium">Time Interval</label>
          <div className="flex gap-1">
            {intervals.map(i => (
              <button
                key={i}
                onClick={() => setInterval(i)}
                className={`flex-1 py-2 text-xs rounded-lg border transition-all ${
                  interval === i 
                    ? 'bg-blue-500/20 border-blue-500/50 text-blue-400' 
                    : 'bg-black/40 border-white/10 text-gray-400 hover:bg-white/5'
                }`}
              >
                {i}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs text-gray-400 font-medium">Risk Settings</label>
          <div className="grid grid-cols-2 gap-2">
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-red-400">SL%</span>
              <input 
                type="number"
                value={stopLoss}
                onChange={(e) => setStopLoss(parseFloat(e.target.value))}
                className="w-full bg-black/40 border border-white/10 rounded-lg pl-8 pr-2 py-2 text-sm text-white focus:outline-none"
              />
            </div>
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-green-400">TP%</span>
              <input 
                type="number"
                value={takeProfit}
                onChange={(e) => setTakeProfit(parseFloat(e.target.value))}
                className="w-full bg-black/40 border border-white/10 rounded-lg pl-8 pr-2 py-2 text-sm text-white focus:outline-none"
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col justify-end">
          <button
            onClick={handleRunBacktest}
            disabled={isBacktesting}
            className="w-full h-10 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white rounded-lg font-medium flex items-center justify-center gap-2 transition-all shadow-lg shadow-blue-900/20"
          >
            {isBacktesting ? (
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
              >
                <Play className="w-4 h-4" />
              </motion.div>
            ) : <Play className="w-4 h-4 fill-current" />}
            {isBacktesting ? 'Simulating...' : 'Run Analysis'}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {error && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3 text-red-400 text-sm"
          >
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            {error}
          </motion.div>
        )}

        {result && (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-6"
          >
            {/* Summary Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-white/5 p-4 rounded-xl border border-white/10 space-y-1">
                <span className="text-xs text-gray-400 font-medium">Total Return</span>
                <div className={`text-2xl font-bold flex items-center gap-2 ${result.totalPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {result.totalPnL >= 0 ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
                  {result.totalPnLPercent.toFixed(2)}%
                </div>
                <span className="text-[10px] text-gray-500">${result.totalPnL.toLocaleString()} profit</span>
              </div>
              
              <div className="bg-white/5 p-4 rounded-xl border border-white/10 space-y-1">
                <span className="text-xs text-gray-400 font-medium">Win Rate</span>
                <div className="text-2xl font-bold text-white mb-1">
                  {result.winRate.toFixed(1)}%
                </div>
                <div className="w-full bg-gray-800 h-1 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-blue-500 transition-all duration-1000" 
                    style={{ width: `${result.winRate}%` }}
                  />
                </div>
              </div>

              <div className="bg-white/5 p-4 rounded-xl border border-white/10 space-y-1">
                <span className="text-xs text-gray-400 font-medium">Max Drawdown</span>
                <div className="text-2xl font-bold text-red-400">
                  -{result.maxDrawdown.toFixed(1)}%
                </div>
                <span className="text-[10px] text-gray-500">Max drop from peak</span>
              </div>

              <div className="bg-white/5 p-4 rounded-xl border border-white/10 space-y-1">
                <span className="text-xs text-gray-400 font-medium">Total Trades</span>
                <div className="text-2xl font-bold text-white">
                  {result.trades.length}
                </div>
                <span className="text-[10px] text-gray-500">Over {limit} candles</span>
              </div>
            </div>

            {/* Performance Chart */}
            {renderEquityCurve()}

            {/* Trade History Table */}
            <div className="bg-white/5 rounded-xl border border-white/10 overflow-hidden">
              <button 
                onClick={() => setShowTrades(!showTrades)}
                className="w-full p-4 flex items-center justify-between text-sm font-medium text-white hover:bg-white/5 transition-all"
              >
                <div className="flex items-center gap-2">
                  <History className="w-4 h-4 text-blue-400" />
                  Detailed Trade Execution Log
                </div>
                {showTrades ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
              
              {showTrades && (
                <div className="overflow-x-auto border-t border-white/10">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-black/40 text-gray-400 border-b border-white/10">
                      <tr>
                        <th className="px-4 py-3 font-medium">Entry/Exit Time</th>
                        <th className="px-4 py-3 font-medium">Prices</th>
                        <th className="px-4 py-3 font-medium">Result</th>
                        <th className="px-4 py-3 font-medium">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {result.trades.map((trade, idx) => (
                        <tr key={idx} className="hover:bg-white/5 transition-all group">
                          <td className="px-4 py-3">
                            <div className="text-white group-hover:text-blue-400 transition-colors uppercase">{formatDate(trade.entryTime).split(',')[1]}</div>
                            <div className="text-gray-500 text-[10px]">{formatDate(trade.entryTime).split(',')[0]}</div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="text-gray-400 font-mono">In: {trade.entryPrice.toLocaleString()}</div>
                            <div className="text-white font-mono">Out: {trade.exitPrice.toLocaleString()}</div>
                          </td>
                          <td className="px-4 py-3">
                            <div className={`font-medium ${trade.profit > 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {trade.profit > 0 ? '+' : ''}{trade.profitPercent.toFixed(2)}%
                            </div>
                            <div className="text-[10px] text-gray-500">
                              ${trade.profit.toFixed(2)}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span className="px-2 py-0.5 bg-white/5 rounded-full text-[10px] text-gray-400">
                              {trade.reason}
                            </span>
                          </td>
                        </tr>
                      ))}
                      {result.trades.length === 0 && (
                        <tr>
                          <td colSpan={4} className="px-4 py-12 text-center text-gray-500 italic">
                            No trades matching the strategy criteria were found in this period.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
