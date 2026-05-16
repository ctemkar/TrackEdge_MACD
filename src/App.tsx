import React, { useState, useEffect } from 'react';
import { TrendingUp, Activity, ShieldAlert, ShieldCheck, Info, Wallet, DollarSign, ArrowUpRight, ArrowDownRight, Search, Zap, Loader2, History, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { fetchBinanceData, subscribeToTicker, fetchAllSymbols, fetchTopSymbolsByVolume } from './services/binance';
import { calculateIndicators, evaluateStrategy, Candle, IndicatorResult, StrategySignal } from './services/indicators';
import { scanMarket, MarketScanResult } from './services/scanner';
import { BacktestModule } from './components/BacktestModule';

export default function App() {
  const [activeTab, setActiveTab] = useState<'LIVE' | 'BACKTEST'>('LIVE');
  const [data, setData] = useState<Candle[]>([]);
  const [indicators, setIndicators] = useState<IndicatorResult | null>(null);
  const [strategy, setStrategy] = useState<StrategySignal | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncDetails, setSyncDetails] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [marketPicks, setMarketPicks] = useState<MarketScanResult[]>([]);
  const [symbol, setSymbol] = useState('BTCUSD');
  const [availableSymbols, setAvailableSymbols] = useState<{ label: string, value: string }[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [stopLossPercent, setStopLossPercent] = useState(5);
  const [takeProfitPercent, setTakeProfitPercent] = useState(15);
  const [nextScanSec, setNextScanSec] = useState(30);
  
  const filteredSymbols = availableSymbols.filter(s => 
    s.label.toLowerCase().includes(searchQuery.toLowerCase()) || 
    s.value.toLowerCase().includes(searchQuery.toLowerCase())
  ).slice(0, 300); // increased limit for broader discovery
  
  // Persistence-enabled state
  const [balance, setBalance] = useState(() => {
    const saved = localStorage.getItem('te_balance');
    return saved ? (parseFloat(saved) || 800) : 800;
  });
  
  interface Holding {
    id: string;
    symbol: string;
    amount: number;
    entryPrice: number;
    time: string;
  }

  const [holdings, setHoldings] = useState<Holding[]>(() => {
    const saved = localStorage.getItem('te_holdings');
    if (!saved) return [];
    try {
      const parsed = JSON.parse(saved);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  });
  
  const [tradeHistory, setTradeHistory] = useState<{ type: 'BUY' | 'SELL', symbol: string, price: number, entryPrice?: number, amount: number, time: string, reason?: string, pnl?: number, pnlPct?: number }[]>(() => {
    const saved = localStorage.getItem('te_history');
    try {
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  
  const [autoTrade, setAutoTrade] = useState(() => {
    const saved = localStorage.getItem('te_auto_trade');
    return saved !== null ? saved === 'true' : true;
  });
  const [useBNBFees, setUseBNBFees] = useState(true);
  const [isRealMode, setIsRealMode] = useState(() => {
    const saved = localStorage.getItem('te_real_mode');
    return saved !== null ? saved === 'true' : false;
  });
  const [showSyncError, setShowSyncError] = useState(true);
  const [maxConcurrentTrades, setMaxConcurrentTrades] = useState(15);
  const [maxDrawdownPercent, setMaxDrawdownPercent] = useState(10);
  const [isDefensiveMode, setIsDefensiveMode] = useState(false);
  const [systemLogs, setSystemLogs] = useState<{ time: string, message: string, type: 'info' | 'success' | 'warning' }[]>([]);
  const [holdingPrices, setHoldingPrices] = useState<Record<string, number>>({});
  const [cooldowns, setCooldowns] = useState<Record<string, number>>({});
  const [isSyncing, setIsSyncing] = useState(false);
  const [serverStatus, setServerStatus] = useState<'IDLE' | 'OK' | 'ERROR'>('IDLE');
  const [serverConfig, setServerConfig] = useState<{ 
    realTradingEnabled: boolean, 
    hasKeys: boolean, 
    outboundIp?: string,
    exchange?: string,
    type?: string
  } | null>(null);
  const [isBotActive, setIsBotActive] = useState(false);
  const tradeLockout = React.useRef<Set<string>>(new Set());
  const isSyncingRef = React.useRef(false);
  const scanningRef = React.useRef(false);
  
  // Refs for scan logic to avoid dependency loops
  const holdingsRef = React.useRef(holdings);
  const autoTradeRef = React.useRef(autoTrade);
  const maxConcurrentTradesRef = React.useRef(maxConcurrentTrades);

  React.useEffect(() => {
    holdingsRef.current = holdings;
    autoTradeRef.current = autoTrade;
    maxConcurrentTradesRef.current = maxConcurrentTrades;
  }, [holdings, autoTrade, maxConcurrentTrades]);

  const [seedCapital, setSeedCapital] = useState(() => {
    const saved = localStorage.getItem('te_seed');
    return saved ? (parseFloat(saved) || 800) : 800;
  });

  const [benchmarkCapital, setBenchmarkCapital] = useState(() => {
    const saved = localStorage.getItem('te_benchmark_capital');
    return saved ? (parseFloat(saved) || 800) : 800;
  });

  // --- CORE SYSTEM FUNCTIONS (ORDER CRITICAL) ---
  const addLog = React.useCallback((message: string, type: 'info' | 'success' | 'warning' = 'info') => {
    setSystemLogs(prev => [{ time: new Date().toLocaleTimeString(), message, type }, ...prev].slice(0, 30));
  }, []);

  const syncRealBalance = React.useCallback(async () => {
    if (isSyncingRef.current) return false;
    isSyncingRef.current = true;
    setIsSyncing(true);
    addLog(`INITIATING EXCHANGE HANDSHAKE...`, 'info');
    
    try {
      const resp = await fetch('/api/binance/balance');
      if (!resp.ok) {
        const errorData = await resp.json().catch(() => ({}));
        let message = errorData.message || `Server responded with ${resp.status}`;
        
        if (message.includes('-2015') || message.includes('API key') || message.includes('permission')) {
          const currentIp = serverConfig?.outboundIp || 'Unknown';
          message = `AUTH ERROR: Detected IP: ${currentIp}. If using Binance, ensure IP is unrestricted in API settings and "Enable Futures" is selected. If using Gemini, double-check your keys (API Key & Secret).`;
          setIsRealMode(false);
          setSyncError(message);
        } else if (message.includes('-1021')) {
          message = "TIMESTAMP REJECTED. Your local clock may be out of sync with exchange servers.";
          setSyncError(message);
        } else {
          setSyncError(message);
        }
        
        return false;
      }
      
      const data = await resp.json();
      if (data.status === 'success') {
        const usdt = data.balance['USDT'] || 0;
        setBalance(usdt);
        
        let freshHoldings: Holding[] = [];
        if (data.positions) {
          freshHoldings = Object.entries(data.positions).map(([coin, info]: [string, any]) => {
            const coinUpper = coin.toUpperCase();
            let normalizedSymbol = coinUpper.endsWith('USD') || coinUpper.endsWith('USDT') 
              ? coinUpper 
              : (data.exchange === 'binance' ? `${coinUpper}USDT` : `${coinUpper}USD`);

            // PRICE RESOLUTION: Do not default to 1 as it creates "Ghost Equity"
            const price = marketPicks.find(p => p.symbol === normalizedSymbol)?.lastPrice || 
                          holdingPrices[normalizedSymbol] || 0; // Default 0
            
            // Final safety filter for 'T' assets if exchange is Gemini
            if (data.exchange === 'gemini' && normalizedSymbol.endsWith('TUSD') && normalizedSymbol !== 'USDTUSD') {
              return null;
            }

            if (info.amount <= 0) return null;

            return {
              symbol: normalizedSymbol,
              amount: info.amount,
              entryPrice: price,
              time: new Date().toISOString()
            };
          }).filter((h): h is Holding => h !== null);

          setHoldings(freshHoldings);
        }

        const totalPositionsValue = freshHoldings.reduce((sum, h) => {
           const price = marketPicks.find(p => p.symbol === h.symbol)?.lastPrice || holdingPrices[h.symbol] || h.entryPrice;
           return sum + (price * h.amount);
        }, 0);
        
        const currentEquity = usdt + totalPositionsValue;

        // Auto-initialize baseline if placeholder or first sync in real mode
        const defaults = [0, 600, 800, 1000];
        if (usdt > 0 && (defaults.includes(benchmarkCapital) || (!isRealMode && !holdings.length))) {
          setBenchmarkCapital(currentEquity);
          addLog(`BASIS LOCKED: Tracking performance from $${currentEquity.toFixed(2)} baseline.`, 'info');
        }

        // GHOST BASIS RESET: If baseline is huge but equity is 0/small on first real sync, auto-correct
        if (isRealMode && benchmarkCapital > 2000 && currentEquity < 100 && usdt === 0) {
           addLog(`GHOST BASIS REJECTED: Resetting anomalous $${benchmarkCapital.toFixed(2)} baseline to reality.`, 'warning');
           setBenchmarkCapital(currentEquity);
        }
        
        setSyncError(null);
        addLog(`SYNC SUCCESS: [${data.account || 'Margin'}] Total Equity $${currentEquity.toFixed(2)} (Cash: $${usdt.toFixed(2)})`, 'success');
        setServerStatus('OK');
        return true;
      } else {
        setSyncError(data.message || 'Unknown balance sync error');
        addLog(`SYNC FAILED: ${data.message || 'Unknown error'}`, 'warning');
        return false;
      }
    } catch (e: any) {
      console.error('Sync Error:', e);
      addLog(`SYNC ERROR: ${e.message}`, 'warning');
      setSyncError(e.message);
      setServerStatus('ERROR');
      return false;
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [addLog, serverConfig?.outboundIp, benchmarkCapital, holdings.length, isRealMode, marketPicks, holdingPrices]);

  const checkServer = React.useCallback(async () => {
    try {
      const resp = await fetch('/api/health');
      if (resp.ok) {
        const data = await resp.json();
        setServerStatus('OK');
        setServerConfig({
          ...data.config,
          outboundIp: data.outboundIp,
          exchange: data.exchange,
          type: data.type
        });
      }
      else setServerStatus('ERROR');
    } catch {
      setServerStatus('ERROR');
    }
  }, []);

  const executeTrade = React.useCallback(async (type: 'BUY' | 'SELL', tradeSymbol: string, price: number, reason: string = 'Strategy Match', targetId?: string) => {
    if (loading || !price) return;
    
    if (tradeSymbol.includes('undefined') || price <= 0) {
       addLog(`TRADE ABORTED: Invalid symbol or price [${tradeSymbol} @ ${price}]`, 'warning');
       return;
    }

    if (type === 'SELL') {
      const isHeld = targetId 
        ? holdings.some(h => h.id === targetId)
        : holdings.some(h => h.symbol === tradeSymbol);
      if (!isHeld) return;
    }

    const lockKey = `${type}_${tradeSymbol}_${targetId || 'all'}`;
    if (tradeLockout.current.has(lockKey)) return;
    tradeLockout.current.add(lockKey);
    setTimeout(() => tradeLockout.current.delete(lockKey), 5000);

    const time = new Date().toISOString();
    
    if (isRealMode) {
      addLog(`EXECUTING REAL ${type}: ${tradeSymbol} @ $${price} [${reason}]`, 'info');
      try {
        const slotsAvailable = Math.max(1, maxConcurrentTrades - holdings.length);
        const currentBalance = Math.max(0, balance);
        let allocation = Math.min(currentBalance, currentBalance / slotsAvailable);
        
        if (allocation < 10) {
           addLog(`TRADE ABORTED: Available allocation ($${allocation.toFixed(2)}) below minimum threshold ($10).`, 'warning');
           return;
        }
        
        if (isDefensiveMode && type === 'BUY') {
          allocation *= 0.5;
          addLog(`ADAPTIVE DEFENSE: Reducing trade allocation by 50% for ${tradeSymbol}`, 'info');
        }

        const amount = type === 'BUY' 
          ? allocation / price 
          : (holdings.find(h => h.symbol === tradeSymbol)?.amount || 0);

        if (amount <= 0 && type === 'BUY') {
           addLog(`TRADE ABORTED: Insufficient $USDT Balance to buy ${tradeSymbol}`, 'warning');
           return;
        }

        const resp = await fetch('/api/binance/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: tradeSymbol,
            side: type,
            type: 'MARKET',
            amount: amount > 0 ? amount : undefined
          })
        });

        const result = await resp.json();
        if (result.status === 'success') {
          addLog(`REAL ${type} SUCCESS: ${tradeSymbol}`, 'success');
          setTimeout(syncRealBalance, 1500); 
        } else {
          throw new Error(result.message || 'Order failed');
        }
      } catch (e: any) {
        addLog(`REAL ${type} FAILED: ${e.message}`, 'warning');
        return;
      }
    } else {
      if (type === 'BUY') {
        if (holdings.length >= maxConcurrentTrades) {
          addLog(`BUY SKIPPED: Max concurrent trades (${maxConcurrentTrades}) reached.`, 'warning');
          return;
        }

        const slotsAvailable = Math.max(1, maxConcurrentTrades - holdings.length);
        const currentBalance = Math.max(0, balance);
        let allocation = Math.min(currentBalance / slotsAvailable, currentBalance);
        
        if (allocation < 10) {
          addLog(`PAPER TRADE SKIPPED: Insufficient balance for minimum $10 allocation.`, 'warning');
          return;
        }

        const amount = allocation / price;
        const holdingId = Math.random().toString(36).substring(2, 15);
        
        let commission = 0.001;
        if (allocation > 500) commission = 0.0008; 
        if (serverConfig?.exchange === 'gemini') commission = 0.004; 
        if (useBNBFees && serverConfig?.exchange !== 'gemini') commission *= 0.75; 

        setBalance(prev => prev - allocation);
        setHoldings(prev => [...prev, { id: holdingId, symbol: tradeSymbol, amount, entryPrice: price, time }]);
        setTradeHistory(prev => [{ type, symbol: tradeSymbol, price, amount, time, reason }, ...prev]);
        addLog(`PAPER BUY: ${tradeSymbol} @ $${price} [${reason}]`, 'success');
      } else {
        // If targetId is provided, close ONLY that one. Otherwise close ALL for this symbol.
        const holdingsToClose = targetId 
          ? holdings.filter(h => h.id === targetId)
          : holdings.filter(h => h.symbol === tradeSymbol);

        if (holdingsToClose.length > 0) {
          let totalFinalSellValue = 0;
          let totalEntryValue = 0;
          let totalAmount = 0;

          holdingsToClose.forEach(h => {
             const sellValue = h.amount * price;
             const entryValue = h.amount * h.entryPrice;
             
             const commissionRate = serverConfig?.exchange === 'gemini' ? 0.004 : 0.001;
             const sellCommission = sellValue * commissionRate;
             const finalSellValue = sellValue - sellCommission;

             totalFinalSellValue += finalSellValue;
             totalEntryValue += entryValue;
             totalAmount += h.amount;
          });

          const pnl = totalFinalSellValue - totalEntryValue;
          const pnlPct = (pnl / totalEntryValue) * 100;

          setBalance(prev => prev + totalFinalSellValue);
          
          if (targetId) {
            setHoldings(prev => prev.filter(h => h.id !== targetId));
          } else {
            setHoldings(prev => prev.filter(h => h.symbol !== tradeSymbol));
          }

          if (pnlPct < 0) {
             setCooldowns(prev => ({ ...prev, [tradeSymbol]: Date.now() + (1000 * 60 * 30) }));
             addLog(`TRADE EXIT [${tradeSymbol}]: Loss of $${Math.abs(pnl).toFixed(2)} (${pnlPct.toFixed(2)}%)`, 'warning');
          } else {
             addLog(`TRADE EXIT [${tradeSymbol}]: Profit of $${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`, 'success');
          }

          setTradeHistory(prev => [{ 
            type, 
            symbol: tradeSymbol, 
            price, 
            entryPrice: totalEntryValue / totalAmount, 
            amount: totalAmount, 
            time, 
            reason, 
            pnl, 
            pnlPct 
          }, ...prev]);
          
          addLog(`PAPER SELL: ${tradeSymbol} @ $${price} | P&L: ${pnlPct.toFixed(2)}% [${reason}]`, pnl >= 0 ? 'success' : 'warning');
        }
      }
    }
  }, [symbol, holdings, maxConcurrentTrades, useBNBFees, isRealMode, balance, syncRealBalance, addLog, isDefensiveMode, serverConfig?.exchange, loading]);



  const liquidateAll = React.useCallback(async () => {
    if (holdings.length === 0) return;
    
    const confirmed = window.confirm(`LIQUIDATION PROTOCOL: Close all ${holdings.length} active positions at market price?`);
    if (!confirmed) return;
    
    addLog(`LIQUIDATION START: Closing ${holdings.length} vectors...`, 'warning');
    
    const currentPositions = [...holdings];
    for (const h of currentPositions) {
      const price = holdingPrices[h.symbol] || (h.symbol === symbol ? currentPrice : h.entryPrice);
      if (price) {
        await executeTrade('SELL', h.symbol, price, 'EMERGENCY_LIQUIDATION', h.id);
        await new Promise(r => setTimeout(r, 600));
      }
    }
    
    addLog(`LIQUIDATION COMPLETE. All positions closed.`, 'success');
  }, [holdings, holdingPrices, symbol, currentPrice, executeTrade, addLog]);

  useEffect(() => {
    checkServer();
  }, [checkServer]);

  // Note: Automatic sync disabled to respect user instruction: "dont make the live futures active unless I tell you!!"
  // We only sync and activate real mode if the user explicitly clicks the "Live Futures" button.
  /*
  useEffect(() => {
    if (serverConfig?.hasKeys && !isRealMode) {
      syncRealBalance();
    }
  }, [serverConfig?.hasKeys]);
  */

  // Persistence Sync
  useEffect(() => {
    localStorage.setItem('te_balance', balance.toString());
    localStorage.setItem('te_holdings', JSON.stringify(holdings));
    localStorage.setItem('te_history', JSON.stringify(tradeHistory));
    localStorage.setItem('te_seed', seedCapital.toString());
    localStorage.setItem('te_benchmark_capital', benchmarkCapital.toString());
    localStorage.setItem('te_auto_trade', autoTrade.toString());
    localStorage.setItem('te_real_mode', isRealMode.toString());
  }, [balance, holdings, tradeHistory, seedCapital, benchmarkCapital, autoTrade, isRealMode]);

  // Baseline Safety: If paper trading and baseline is from a ghost real-sync session, fix it.
  useEffect(() => {
    if (!isRealMode && holdings.length === 0 && benchmarkCapital > (balance * 2) && balance === 800) {
      addLog("GHOST BASIS PURGED: Recalibrating laboratory benchmark.", 'info');
      setBenchmarkCapital(balance);
    }
  }, [isRealMode, balance, holdings.length, benchmarkCapital, addLog]);

  const currentHolding = holdings.find(h => h.symbol === symbol);
  const stopLossPrice = (currentHolding && currentPrice) ? currentHolding.entryPrice * (1 - stopLossPercent / 100) : 0;

  const [scanProgress, setScanProgress] = useState({ current: 0, total: 0 });

  const formatPrice = (price: number) => {
    if (price === 0) return '0.00';
    if (price < 0.0001) return price.toFixed(8);
    if (price < 1) return price.toFixed(6);
    return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
  };

  // Emergency Drawdown Watcher
  useEffect(() => {
    if (!isRealMode || holdings.length === 0 || !benchmarkCapital) return;

    const totalPositionsValue = holdings.reduce((sum, h) => {
      const price = holdingPrices[h.symbol] || h.entryPrice;
      return sum + (price * h.amount);
    }, 0);
    
    const equity = balance + totalPositionsValue;
    const currentDrawdown = ((benchmarkCapital - equity) / benchmarkCapital) * 100;

    if (currentDrawdown >= maxDrawdownPercent) {
      addLog(`CRITICAL DRAWDOWN DETECTED: ${currentDrawdown.toFixed(2)}% vs ${maxDrawdownPercent}% limit. TRIGGERING SHIELD.`, 'warning');
      const triggerShield = async () => {
         // Force liquidate everything
         for (const h of holdings) {
            const price = holdingPrices[h.symbol] || h.entryPrice;
            await executeTrade('SELL', h.symbol, price, 'EMERGENCY_SHIELD: MAX DRAWDOWN REACHED');
            await new Promise(r => setTimeout(r, 800));
         }
      };
      triggerShield();
    }
  }, [balance, holdings, holdingPrices, benchmarkCapital, maxDrawdownPercent, isRealMode, executeTrade, addLog]);

  // Handle "Please stop trading" request
  useEffect(() => {
    const handleEmergencyStop = async () => {
      if (autoTrade) {
        setAutoTrade(false);
        if (holdings.length > 0) {
          addLog("EMERGENCY STOP: Disabling systems and liquidating positions...", "warning");
          await liquidateAll();
        }
      }
    };
    
    // We only trigger this once if it was active on mount after the user's manual stop request
    const wasJustStopped = localStorage.getItem('te_stop_req') === 'true';
    if (wasJustStopped) {
      localStorage.removeItem('te_stop_req');
      handleEmergencyStop();
    }
  }, [holdings.length, autoTrade]);

  // Market Scanner Logic
  const performScan = React.useCallback(async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setScanning(true);
    setIsBotActive(true);
    try {
      setScanProgress({ current: 0, total: 1 }); // Initial state to show bar
      const allSymbols = await fetchAllSymbols();
      const allValues = allSymbols.map(s => s.value);
      const symbolsToScan = Array.from(new Set([symbol, ...allValues])); // Removed slice to allow all assets (e.g. 750+) to be scanned
      
      setScanProgress({ current: 0, total: symbolsToScan.length });
      
      let lastLoggedCount = 0;
      const results = await scanMarket(symbolsToScan, (current, total) => {
        setScanProgress({ current, total });
        // Log every 50 assets to keep "pulse" visible
        if (current >= lastLoggedCount + 50 || current === total) {
          lastLoggedCount = current;
        }
      });

      setMarketPicks(results);
      // Wait a moment before resetting progress to let the user see "Complete" in the UI
      setTimeout(() => setScanProgress({ current: 0, total: 0 }), 3000);
      
      const currentAutoTrade = autoTradeRef.current;
      const currentHoldings = holdingsRef.current;
      const currentMaxTrades = maxConcurrentTradesRef.current;

      if (currentAutoTrade && currentHoldings.length > 0) {
        currentHoldings.forEach(holding => {
          const scanResult = results.find(r => r.symbol === holding.symbol);
          if (scanResult) {
            const price = scanResult.lastPrice;
            const slTrigger = price <= holding.entryPrice * (1 - stopLossPercent / 100);
            const tpTrigger = price >= holding.entryPrice * (1 + takeProfitPercent / 100);

            if (slTrigger) {
              executeTrade('SELL', holding.symbol, price, 'AUTO_EXIT: PORTFOLIO STOP LOSS');
            } else if (tpTrigger) {
              executeTrade('SELL', holding.symbol, price, 'AUTO_EXIT: PORTFOLIO TAKE PROFIT');
            }
          }
        });
      }

      if (currentAutoTrade) {
        const potentialBuys = results
          .filter(r => r.signal.overall === 'BUY' && r.signal.score >= 5)
          .filter(r => !currentHoldings.some(h => h.symbol === r.symbol))
          .filter(r => !cooldowns[r.symbol] || cooldowns[r.symbol] < Date.now());

        if (currentHoldings.length < currentMaxTrades) {
          const availableSlots = currentMaxTrades - currentHoldings.length;
          const toBuy = potentialBuys.slice(0, availableSlots);
          
          if (toBuy.length > 0) {
            toBuy.forEach(pick => {
              executeTrade('BUY', pick.symbol, pick.lastPrice, `AI DISCOVERY: CONFIDENCE ${pick.signal.score}/10`);
            });
          }
        }
      }
    } catch (error) {
      console.error('Scan failed', error);
      addLog('AI Scanner error: API limit or connectivity issue.', 'warning');
    } finally {
      scanningRef.current = false;
      setScanning(false);
      setTimeout(() => setIsBotActive(false), 2000);
    }
  }, [symbol, executeTrade, stopLossPercent, takeProfitPercent, addLog]);
 // Removed 'scanning' from dependencies

  const resetAccount = React.useCallback(() => {
    setBalance(seedCapital);
    setBenchmarkCapital(seedCapital);
    setHoldings([]);
    setTradeHistory([]);
    setSystemLogs([]);
    localStorage.clear();
    localStorage.setItem('te_seed', seedCapital.toString());
    localStorage.setItem('te_benchmark_capital', seedCapital.toString());
    addLog(`Laboratory reset: Initializing with $${seedCapital} capital.`, 'info');
  }, [seedCapital, addLog]);

  useEffect(() => {
    const initSymbols = async () => {
      const all = await fetchAllSymbols();
      setAvailableSymbols(all);
      addLog(`Market Metadata: ${all.length} exchange vectors mapped.`, 'info');
      addLog(`PROTOCOL STATUS: Autonomous Execution is ${autoTrade ? 'ACTIVE' : 'IDLE'}`, autoTrade ? 'success' : 'info');
    };
    initSymbols();
  }, []);

  // Main Data Loading & Scanner Auto-Refresh
  useEffect(() => {
    const loadData = async (silent = false) => {
      // ONLY show the dark loading screen if we have zero data (initial boot or fresh asset)
      if (!silent && data.length === 0) setLoading(true); 
      
      try {
        const candles = await fetchBinanceData(symbol);
        setData(candles);
        const inds = calculateIndicators(candles);
        setIndicators(inds);
        const sig = evaluateStrategy(candles, inds);
        setStrategy(sig);
        if (candles.length > 0) {
          const price = candles[candles.length - 1].close;
          setCurrentPrice(price);
          setHoldingPrices(prev => ({ ...prev, [symbol]: price }));
        }
      } catch (err) {
        console.error("Data load failed", err);
      } finally {
        setLoading(false);
      }
    };

    loadData();
    performScan();

    const refreshInterval = setInterval(() => {
      loadData(true);
      performScan();
      setNextScanSec(30);
    }, 30000);

    const countdownInterval = setInterval(() => {
      setNextScanSec(prev => Math.max(0, prev - 1));
    }, 1000);

    const unsubscribe = subscribeToTicker(symbol, (price) => {
      setCurrentPrice(price);
    });

    return () => {
      unsubscribe();
      clearInterval(refreshInterval);
      clearInterval(countdownInterval);
    };
  }, [symbol, performScan]);

  // Dedicated Portfolio Price Watcher (High Frequency)
  useEffect(() => {
    if (holdings.length === 0) return;

    const pollHoldingPrices = async () => {
      const updates: Record<string, number> = {};
      await Promise.all(holdings.map(async (h) => {
        try {
          const candles = await fetchBinanceData(h.symbol, '1m', 2);
          if (candles.length > 0) {
            const lastPrice = candles[candles.length - 1].close;
            const prevPrice = holdingPrices[h.symbol] || h.entryPrice;
            
            const priceDelta = prevPrice > 1 ? Math.abs((lastPrice - prevPrice) / prevPrice) : 0;
            
            if (lastPrice > 0 && isFinite(lastPrice) && (priceDelta < 3.0 || prevPrice <= 1)) {
                updates[h.symbol] = lastPrice;
            } else if (priceDelta >= 3.0) {
                addLog(`DATA GUARD: Suppressed erratic move for ${h.symbol} ($${lastPrice} vs $${prevPrice})`, 'warning');
            }
          }
        } catch (e) {
          console.warn(`Failed to poll live price for ${h.symbol}`);
        }
      }));
      
      if (Object.keys(updates).length > 0) {
        setHoldingPrices(prev => ({ ...prev, ...updates }));
      }
    };

    const interval = setInterval(pollHoldingPrices, 3000);
    pollHoldingPrices();

    return () => clearInterval(interval);
  }, [holdings.length]);

  useEffect(() => {
    if (holdings.length > 0) {
      holdings.forEach(holding => {
        const price = holdingPrices[holding.symbol] || (holding.symbol === symbol ? currentPrice : null);
        
        if (price) {
          // 1. Hard Stop Loss Check (5%)
          if (price <= holding.entryPrice * (1 - stopLossPercent / 100)) {
            executeTrade('SELL', holding.symbol, price, 'AUTO_EXIT: STOP LOSS (5%)');
          } 
          // 2. Take Profit Check (15%)
          else if (price >= holding.entryPrice * (1 + takeProfitPercent / 100)) {
            executeTrade('SELL', holding.symbol, price, 'AUTO_EXIT: TAKE PROFIT (15%)');
          }
          // Strategy-based Exit removed to respect user's strict 15%/5% TP/SL bounds
        }
      });
    }
    
    // 4. Current Symbol Auto-Buy (if not held and slot available)
    if (holdings.length < maxConcurrentTrades && strategy && strategy.overall === 'BUY' && autoTrade && currentPrice && strategy.score >= 5) {
      const isAlreadyHeld = holdings.some(h => h.symbol === symbol);
      const isOnCooldown = cooldowns[symbol] && cooldowns[symbol] > Date.now();
      if (!isAlreadyHeld && !isOnCooldown) {
        executeTrade('BUY', symbol, currentPrice, `AUTO_ENTRY: CROSSOVER SIGNAL [${strategy.score}/10]`);
      }
    }
  }, [currentPrice, strategy, autoTrade, holdings, symbol, executeTrade, stopLossPercent, takeProfitPercent, maxConcurrentTrades, holdingPrices, cooldowns]);

  const calculateEquity = () => {
    const holdingsValue = holdings.reduce((acc, h) => {
      // Priority: Live Watcher -> Selected Symbol Cache -> Market Scan -> Entry
      const livePrice = holdingPrices[h.symbol];
      const selectedPrice = h.symbol === symbol ? currentPrice : null;
      const scanPrice = marketPicks.find(p => p.symbol === h.symbol)?.lastPrice;
      
      const price = livePrice || selectedPrice || scanPrice || h.entryPrice;
      return acc + (h.amount * price);
    }, 0);
    return balance + holdingsValue;
  };
  
  const equity = calculateEquity();
  const totalInvested = holdings.reduce((acc, h) => acc + (h.amount * h.entryPrice), 0);
  
  // Anti-Glitich: If equity is non-finite or impossible, it's a data core issue
  // We cap at $100,000,000 to allow "Whale" mode while still blocking glitches
  const isDataBroken = !isFinite(equity) || equity > 100000000 || equity < 0; 
  
  const pnl = equity - benchmarkCapital;
  const pnlPercent = benchmarkCapital > 0 ? (pnl / benchmarkCapital) * 100 : 0;
  const investedPct = benchmarkCapital > 0 ? (totalInvested / benchmarkCapital) * 100 : 0;

  // Auto-Recovery - Clean wipe if core state is corrupted
  useEffect(() => {
    if (isDataBroken) {
        addLog("CRITICAL: PORTFOLIO DATA OVERFLOW DETECTED. PURGING CORRUPT POSITIONS.", 'warning');
        resetAccount();
    }
  }, [isDataBroken]);

  const showInitialLoading = loading && data.length === 0;

  return (
    <div className="min-h-screen bg-[#E4E3E0] text-[#141414] p-4 md:p-8 font-sans selection:bg-[#F27D26] selection:text-white overflow-x-hidden">
      <header className="max-w-7xl mx-auto mb-8 flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-[#141414] pb-4">
        <div className="flex flex-col">
          <div className="flex items-center gap-2 mb-1">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] opacity-60">
              {isRealMode ? 'LIVE FUTURES ACCOUNT ACTIVE' : 'PAPER TRADING ENGINE ACTIVE'}
            </p>
          </div>
          <h1 className="text-5xl md:text-7xl font-black tracking-tighter uppercase italic leading-none">
            TradeEdge<span className={isRealMode ? 'text-rose-500' : 'text-[#F27D26]'}>{isRealMode ? 'FUTURES' : 'Laboratory'}</span>
          </h1>
          <div className="mt-4 flex flex-wrap items-center gap-3">
             <div className="flex items-center bg-[#141414] p-0.5 rounded-sm overflow-hidden">
                <button 
                  onClick={() => setIsRealMode(false)}
                  className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-tighter transition-all ${!isRealMode ? 'bg-[#F27D26] text-white shadow-lg' : 'text-white/40 hover:text-white'}`}
                >
                  Paper Trading
                </button>
                <button 
                  onClick={async () => {
                    setSyncError(null);
                    if (serverConfig?.hasKeys) {
                      const success = await syncRealBalance();
                      if (success) setIsRealMode(true);
                    }
                    else addLog("API keys required in Settings for Real Mode", "warning");
                  }}
                  disabled={isSyncing}
                  className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-tighter transition-all flex items-center gap-2 ${isRealMode ? 'bg-rose-600 text-white shadow-lg' : 'text-white/40 hover:text-white'} ${isSyncing ? 'opacity-50 cursor-wait' : ''}`}
                >
                  {isSyncing ? <Loader2 size={10} className="opacity-60" /> : null}
                  Live Futures
                </button>
             </div>

             <div className="h-6 w-px bg-[#141414]/10 mx-1" />

             <div className="flex items-center gap-2 bg-[#141414]/5 px-3 py-1 rounded-sm border border-[#141414]/10 shadow-sm">
                <div className="flex items-center gap-1.5">
                  <Zap size={10} className={autoTrade ? 'text-emerald-500 fill-emerald-500' : 'text-gray-400'} />
                  <span className="text-[9px] font-black uppercase tracking-tighter opacity-60">Autonomous</span>
                </div>
                <button 
                  onClick={() => {
                    const newState = !autoTrade;
                    setAutoTrade(newState);
                    addLog(`SYSTEM UPDATE: Autonomous Execution ${newState ? 'ENGAGED' : 'SUSPENDED'}`, newState ? 'success' : 'warning');
                  }}
                  title={autoTrade ? "Disable Auto-Trading" : "Enable Auto-Trading"}
                  className={`w-9 h-4.5 rounded-full transition-all relative cursor-pointer ${autoTrade ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.4)]' : 'bg-gray-400 opacity-60'}`}
                >
                  <div className={`absolute top-0.5 w-3.5 h-3.5 bg-white rounded-full transition-all flex items-center justify-center ${autoTrade ? 'left-5' : 'left-0.5'}`}>
                    <div className={`w-1 h-1 rounded-full ${autoTrade ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                  </div>
                </button>
             </div>

             <div className="flex items-center bg-white border border-[#141414] rounded-sm overflow-hidden">
                <button 
                  onClick={() => setActiveTab('LIVE')}
                  className={`px-3 py-1 text-[9px] font-black uppercase tracking-tighter transition-colors ${activeTab === 'LIVE' ? 'bg-[#141414] text-white' : 'hover:bg-gray-100 flex items-center gap-1'}`}
                >
                  <Activity size={10} className={isRealMode ? 'text-rose-500' : 'text-[#F27D26]'} />
                  Terminal
                </button>
                <button 
                  onClick={() => setActiveTab('BACKTEST')}
                  className={`px-3 py-1 text-[9px] font-black uppercase tracking-tighter transition-colors ${activeTab === 'BACKTEST' ? 'bg-[#141414] text-white' : 'hover:bg-gray-100 flex items-center gap-1'}`}
                >
                  <History size={10} className="text-blue-500" />
                  Strategy Lab
                </button>
             </div>

             {isRealMode && !serverConfig?.realTradingEnabled && (
                <span className="text-[9px] font-black text-rose-600 bg-rose-50 px-2 py-0.5 border border-rose-200">READ-ONLY MODE</span>
             )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-3">
          <div className="flex items-center gap-3">
            <div className="relative group">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 opacity-30 group-focus-within:opacity-100 transition-opacity" />
              <input 
                type="text" 
                placeholder="Find Asset..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-white/50 border border-[#141414]/10 rounded-sm py-1 pl-9 pr-3 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-[#F27D26] w-[140px]"
              />
            </div>
            <select 
              value={symbol} 
              onChange={(e) => {
                setSymbol(e.target.value);
                setSearchQuery('');
              }}
              className="bg-transparent border-none font-black text-2xl uppercase focus:ring-0 cursor-pointer text-right max-w-[180px]"
            >
              {filteredSymbols.length === 0 ? (
                <option value={symbol}>{symbol.replace('USDT', '')}/USDT</option>
              ) : (
                filteredSymbols.map(sym => (
                  <option key={sym.value} value={sym.value}>{sym.label}/USDT</option>
                ))
              )}
            </select>
            <div className="text-right">
              <p className="text-sm font-mono opacity-50 uppercase tracking-tighter">Market Price</p>
              <p className={`text-3xl font-black tracking-tighter tabular-nums ${strategy?.trend === 'UP' ? 'text-emerald-600' : 'text-rose-600'}`}>
                ${formatPrice(currentPrice || 0)}
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto">
        <div className="w-full">
          {/* Main Trading Terminal */}
          <div className={activeTab === 'LIVE' ? 'block' : 'hidden'}>
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
              {/* Left Column: AI Scanner & Picks */}
              <div className="lg:col-span-1 flex flex-col gap-8">
          <section className="bg-white border-2 border-[#141414] p-6 shadow-[8px_8px_0px_0px_#141414]">
            <div className="flex items-center justify-between mb-6">
              <div className="flex flex-col">
                <h2 className="font-mono text-[10px] uppercase tracking-[0.3em] flex items-center gap-2">
                  <Search size={14} className="text-[#F27D26]" />
                  Market Protocol
                </h2>
                <span className="text-[8px] font-mono mt-1 uppercase opacity-40">
                  {scanning
                    ? `Scanner Active: ${scanProgress.current} / ${scanProgress.total || 1} Assets`
                    : `Scanner Online: Monitoring ${availableSymbols.length} Assets`}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-mono opacity-40">{scanning ? 'Scanning now' : 'Auto scan ready'}</span>
                <button 
                  onClick={performScan} 
                  className="cursor-pointer"
                  disabled={scanning}
                >
                  <Zap size={14} className="text-[#F27D26]" />
                </button>
              </div>
            </div>

            <div className="mt-3 mb-4">
              <div className="flex justify-between text-[8px] font-mono uppercase opacity-50 mb-1">
                <span>{scanning ? 'Scan Progress' : 'Idle'}</span>
                <span>{scanning ? `${Math.round((scanProgress.current / (scanProgress.total || 1)) * 100)}%` : `${availableSymbols.length} assets`}</span>
              </div>
              <div className="h-1 w-full bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#F27D26]"
                  style={{ width: scanning ? `${(scanProgress.current / (scanProgress.total || 1)) * 100}%` : `${Math.min(100, Math.max(0, availableSymbols.length > 0 ? 100 : 0))}%` }}
                />
              </div>
            </div>

             <div className="space-y-4">
              <div className="grid grid-cols-5 items-center border-b pb-2 text-[8px] font-mono opacity-40 uppercase tracking-widest px-2">
                <span>Asset</span>
                <span className="text-center">Trend/RSI</span>
                <span className="text-center">Score</span>
                <span className="text-center">Signal</span>
                <span className="text-right">Action</span>
              </div>
              <div className="space-y-2 max-h-[400px] overflow-y-auto custom-scrollbar pr-2">
                {marketPicks.slice(0, 150).map((pick) => (
                  <div key={pick.symbol} className="grid grid-cols-5 items-center group py-1.5 hover:bg-gray-50/50 px-2 border-b border-gray-50 transition-colors">
                    <button 
                      onClick={() => setSymbol(pick.symbol)}
                      className="text-[10px] font-black hover:text-[#F27D26] transition-colors text-left"
                    >
                      {pick.symbol.replace('USDT', '')}
                    </button>
                    
                    <div className="text-center flex flex-col">
                      <div className="flex items-center justify-center gap-1">
                         <span className={`text-[9px] font-mono font-bold ${pick.trend === 'UP' ? 'text-emerald-600' : 'text-rose-600'}`}>
                           {pick.trend}
                         </span>
                         <span className="text-[7px] font-mono opacity-30">@{pick.rsi?.toFixed(0)}</span>
                      </div>
                    </div>

                    <div className="text-center">
                      <span className={`text-[9px] font-mono font-bold ${
                        pick.signal.score >= 8 ? 'text-emerald-500' :
                        pick.signal.score >= 5 ? 'text-[#F27D26]' :
                        'opacity-30'
                      }`}>
                        {pick.signal.score}/10
                      </span>
                    </div>

                    <div className="flex justify-center">
                      <div className={`text-[8px] font-black px-1 rounded-sm ${
                        pick.signal.overall === 'BUY' ? 'bg-emerald-100 text-emerald-800' : 
                        pick.signal.overall === 'SELL' ? 'bg-rose-100 text-rose-800' : 'bg-gray-100 text-gray-400'
                      }`}>
                        {pick.signal.overall}
                      </div>
                    </div>

                    <div className="flex justify-end">
                      <button 
                        onClick={() => executeTrade('BUY', pick.symbol, pick.lastPrice, `AI_DISCOVERY_${pick.signal.score}`)}
                        disabled={holdings.length >= maxConcurrentTrades || holdings.some(h => h.symbol === pick.symbol)}
                        className="text-[#141414] hover:bg-[#F27D26] hover:text-white border border-[#141414]/10 text-[7px] px-2 py-0.5 font-bold uppercase transition-all disabled:opacity-0"
                      >
                        Execute
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="hidden mt-8 pt-6 border-t border-dashed border-[#141414]/20">
              {/* System Protocol Logs */}
              <div className="mt-4 bg-[#141414] p-3 rounded-sm">
                <div className="flex justify-between items-center mb-2">
                  <p className="text-[10px] font-mono text-[#F27D26] font-bold uppercase tracking-widest">System Protocols</p>
                  <button onClick={() => setSystemLogs([])} className="text-[8px] font-mono text-white/20 hover:text-white uppercase">Clear</button>
                </div>
                <div className="space-y-1.5 h-[120px] overflow-y-auto custom-scrollbar">
                  {systemLogs.length === 0 ? (
                    <p className="text-[10px] font-mono text-white/20 italic">Awaiting node telemetry...</p>
                  ) : (
                    systemLogs.map((log, i) => (
                      <div key={i} className="text-[10px] font-mono leading-tight border-l border-white/10 pl-2">
                        <span className="text-white/30 mr-2">[{log.time}]</span>
                        <span className={
                          log.type === 'success' ? 'text-emerald-400' :
                          log.type === 'warning' ? 'text-rose-400' : 'text-white/70'
                        }>{log.message}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

                <div className="mt-3 mb-4">
                  <div className="flex justify-between text-[8px] font-mono uppercase opacity-50 mb-1">
                    <span>{scanning ? 'Scan Progress' : 'Scanner Ready'}</span>
                    <span>{scanning ? `${scanProgress.current} / ${scanProgress.total || 1}` : `${availableSymbols.length} assets`}</span>
                  </div>
                  <div className="h-1 w-full bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#F27D26]"
                      style={{ width: scanning ? `${(scanProgress.current / (scanProgress.total || 1)) * 100}%` : `${availableSymbols.length > 0 ? 100 : 0}%` }}
                    />
                  </div>
                </div>
          </section>

          {/* Risk Management Card */}
          <section className="bg-[#141414] text-[#E4E3E0] p-6 rounded-sm shadow-xl relative overflow-hidden">
             <div className="absolute top-0 right-0 p-2 opacity-5">
              <ShieldAlert size={120} strokeWidth={1} />
            </div>
            
            <h2 className="font-mono text-[10px] uppercase tracking-[0.3em] mb-6 flex items-center gap-2 border-b border-white/10 pb-2">
              Risk Guard
            </h2>

              <div className="space-y-6 relative z-10">
                <div>
                  <label className="text-[10px] uppercase font-bold opacity-60 mb-1 block">Laboratory Seed Capital</label>
                  <div className="flex gap-2">
                    <input 
                      type="number" 
                      value={seedCapital}
                      onChange={(e) => setSeedCapital(parseFloat(e.target.value) || 0)}
                      className="bg-white/10 border border-white/20 rounded-sm py-1 px-3 text-xs font-mono w-full focus:outline-none focus:border-[#F27D26]"
                    />
                    <button 
                      onClick={resetAccount}
                      className="text-[10px] font-bold bg-[#F27D26] px-3 py-1 rounded-sm text-white hover:bg-orange-600 transition-colors"
                    >
                      SET
                    </button>
                  </div>
                  <p className="text-[7px] font-mono opacity-30 mt-1">Changes balance only on SET/RESET.</p>
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold opacity-60 mb-1 block">Capital Concentration</label>
                  <input 
                    type="range" 
                    min="1" 
                    max="30" 
                    step="1" 
                    value={maxConcurrentTrades}
                    onChange={(e) => setMaxConcurrentTrades(parseInt(e.target.value))}
                    className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-[#F27D26]"
                  />
                  <div className="flex justify-between font-mono text-[8px] mt-1 opacity-40">
                    <span>Targeted ($$$)</span>
                    <span className="text-[#F27D26] font-bold opacity-100">{maxConcurrentTrades} SLOTS</span>
                    <span>Broad ($)</span>
                  </div>
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold opacity-60 mb-1 block text-emerald-400">Take Profit (Policy: 15%)</label>
                  <input 
                    type="range" 
                    min="1" 
                    max="20" 
                    step="1" 
                    value={takeProfitPercent}
                    onChange={(e) => setTakeProfitPercent(parseFloat(e.target.value))}
                    className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                  />
                  <div className="flex justify-between font-mono text-[8px] mt-1 opacity-40">
                    <span>Scalp (1%)</span>
                    <span className="text-emerald-400 font-bold opacity-100">{takeProfitPercent}% TARGET</span>
                    <span>Swing (20%)</span>
                  </div>
                </div>

                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="text-[10px] uppercase font-bold opacity-60 text-rose-400">Standard Stop Loss</label>
                    <div className="flex gap-1 items-center bg-white/5 border border-white/10 px-1 rounded-sm">
                       <input 
                         type="number" 
                         value={stopLossPercent}
                         onChange={(e) => setStopLossPercent(parseFloat(e.target.value) || 0)}
                         className="w-8 bg-transparent text-[10px] font-mono text-center focus:outline-none"
                         step="0.1"
                       />
                       <span className="text-[8px] opacity-40">%</span>
                    </div>
                  </div>
                  <input 
                    type="range" 
                    min="0.2" 
                    max="10" 
                    step="0.1" 
                    value={stopLossPercent}
                    onChange={(e) => setStopLossPercent(parseFloat(e.target.value))}
                    className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-rose-500"
                  />
                  <div className="flex justify-between font-mono text-[8px] mt-1 opacity-40">
                    <span>Defensive (0.2%)</span>
                    <span className="text-rose-400 font-bold opacity-100">{stopLossPercent}% GUARD</span>
                    <span>Broad (10%)</span>
                  </div>
                </div>

                <div className="p-3 bg-red-950/20 border border-red-500/20 rounded-sm">
                  <div className="flex justify-between items-center mb-2">
                    <div className="flex flex-col">
                      <label className="text-[10px] uppercase font-bold text-rose-300">Portfolio Emergency Shield</label>
                      <span className="text-[7px] opacity-40 uppercase">Liquidation on Drawdown</span>
                    </div>
                    <div className="flex gap-1 items-center bg-black/40 border border-white/10 px-1 rounded-sm">
                       <input 
                         type="number" 
                         value={maxDrawdownPercent}
                         onChange={(e) => setMaxDrawdownPercent(parseFloat(e.target.value) || 0)}
                         className="w-8 bg-transparent text-[10px] font-mono text-center text-rose-300 focus:outline-none"
                         step="1"
                       />
                       <span className="text-[8px] opacity-40">%</span>
                    </div>
                  </div>
                  <input 
                    type="range" 
                    min="1" 
                    max="30" 
                    step="1" 
                    value={maxDrawdownPercent}
                    onChange={(e) => setMaxDrawdownPercent(parseFloat(e.target.value))}
                    className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-rose-700"
                  />
                  <div className="flex justify-between font-mono text-[8px] mt-1 opacity-40">
                    <span>Ultra-Tight (1%)</span>
                    <span className="text-rose-300 font-bold">{maxDrawdownPercent}% MAX DRAWDOWN</span>
                    <span>Loose (30%)</span>
                  </div>
                </div>

                <div className="flex items-center justify-between p-2 bg-emerald-500/10 border border-emerald-500/20 rounded-sm">
                   <div className="flex flex-col">
                      <div className="flex items-center gap-1">
                        <ShieldCheck size={12} className="text-emerald-400" />
                        <span className="text-[10px] uppercase font-black text-emerald-400">Adaptive Defense</span>
                      </div>
                      <span className="text-[7px] opacity-40 leading-tight">HALVES POSITIONS SIZE ON VOLATILITY</span>
                   </div>
                   <button 
                    onClick={() => setIsDefensiveMode(!isDefensiveMode)}
                    className={`px-3 py-1 rounded-xs text-[10px] font-black transition-all ${isDefensiveMode ? 'bg-emerald-500 text-black' : 'bg-white/10 text-white hover:bg-white/20'}`}
                   >
                     {isDefensiveMode ? 'ACTIVE' : 'OFF'}
                   </button>
                </div>

                <div className="pt-4 border-t border-white/10">
                   <div className="flex items-center justify-between mb-4">
                    <div className="flex flex-col">
                      <label className="text-[10px] uppercase font-bold opacity-60">Exchange Node Sync</label>
                      <span className="text-[7px] font-mono opacity-30 uppercase">
                        {isRealMode ? `${(serverConfig?.exchange || 'EXCHANGE').toUpperCase()} ${serverConfig?.type || ''} LINKED` : 'SIMULATION MODE'}
                      </span>
                    </div>
                    <button 
                      onClick={() => {
                        if (isRealMode) setIsRealMode(false);
                        else syncRealBalance();
                      }}
                      disabled={isSyncing}
                      className={`text-[9px] px-3 py-1 font-black transition-all ${isRealMode ? 'bg-[#141414] text-white hover:bg-black/80' : 'bg-[#F27D26] text-white hover:bg-orange-600'} ${isSyncing ? 'opacity-50' : ''}`}
                    >
                      {isSyncing ? 'SYNCING...' : (isRealMode ? 'LEAVE REAL MODE' : 'LINK EXCHANGE')}
                    </button>
                  </div>

                  {serverConfig?.outboundIp && !isRealMode && (
                    <div className="mb-4 p-2 bg-[#F27D26]/10 border border-[#F27D26]/30 rounded-sm">
                       <p className="text-[9px] text-[#F27D26] font-bold uppercase leading-tight">
                         Whitelisting Required
                       </p>
                       <div className="flex items-center justify-between mt-1">
                         <code className="text-[10px] text-white font-mono bg-black/40 px-1">
                           {serverConfig.outboundIp === 'unknown' ? 'Detecting IP...' : serverConfig.outboundIp}
                         </code>
                         <div className="flex gap-2">
                           <button 
                             onClick={checkServer}
                             className="text-[7px] text-white/40 uppercase hover:text-white transition-colors underline"
                           >
                             Refresh
                           </button>
                           {serverConfig.outboundIp !== 'unknown' && (
                             <button 
                               onClick={() => {
                                 navigator.clipboard.writeText(serverConfig.outboundIp || '');
                                 addLog('IP copied. Add to API whitelist if using keys.', 'info');
                               }}
                               className="text-[7px] text-white/40 uppercase hover:text-white transition-colors underline"
                             >
                               Copy
                             </button>
                           )}
                         </div>
                       </div>
                       <p className="text-[7px] text-white/30 mt-1 uppercase italic">
                         Add this IP to API whitelist if connection fails.
                       </p>
                    </div>
                  )}
                  
                  {serverConfig && serverConfig.hasKeys && !serverConfig.realTradingEnabled && (
                    <div className="mb-4 p-2 bg-rose-500/20 border border-rose-500/50 rounded-sm">
                       <p className="text-[9px] text-rose-300 font-bold uppercase leading-tight">
                         Keys detected, but Real Trading is LOCKED.
                       </p>
                       <p className="text-[7px] text-rose-300/60 mt-1 uppercase">
                         Set ENABLE_REAL_TRADING=true in Settings to unlock.
                       </p>
                    </div>
                  )}

                    {syncError && (
                      <div className="mb-4 p-3 bg-rose-600/20 border-2 border-rose-600 rounded-sm relative">
                        <button 
                          onClick={() => setSyncError(null)}
                          className="absolute top-1 right-1 text-white/40 hover:text-white"
                        >
                          ×
                        </button>
                        <p className="text-[10px] text-rose-400 font-black uppercase mb-1">Exchange Handshake Failed</p>
                        <p className="text-[9px] text-white font-mono leading-tight">{syncError}</p>
                      </div>
                    )}

                  {systemLogs.some(l => l.message.includes('INVALID KEY/IP/PERMISSION')) && showSyncError && !syncError && (
                    <div className="mb-4 p-3 bg-rose-600/20 border-2 border-rose-600 rounded-sm relative">
                      <button 
                        onClick={() => setShowSyncError(false)}
                        className="absolute top-1 right-1 text-white/40 hover:text-white"
                      >
                        ×
                      </button>
                      <p className="text-[10px] text-rose-400 font-black uppercase mb-1">Critical: API Restriction Detected</p>
                      <p className="text-[9px] text-white font-mono bg-black/40 p-1 mb-2">SERVER OUTBOUND IP: <span className="text-rose-400 font-bold">{serverConfig?.outboundIp || 'DETECTING...'}</span></p>
                      <ul className="text-[8px] text-white/50 space-y-1 uppercase font-mono list-disc pl-3">
                        <li><span className="text-white font-bold">WHITELIST ERROR:</span> YOU MUST ADD THE IP ABOVE TO YOUR EXCHANGE (BINANCE/GEMINI) WHITELIST.</li>
                        <li><span className="text-white font-bold">PERMISSION DENIED:</span> ENSURE "ENABLE FUTURES" IS CHECKED FOR BINANCE KEYS.</li>
                        <li><span className="text-white font-bold">KEY MISMATCH:</span> ARE YOU USING TESTNET KEYS ON A PROD CLIENT?</li>
                        <li><span className="text-white font-bold">RESTRICTION:</span> THE RESTRICTION WILL REMAIN UNTIL YOU UPDATE YOUR API KEY SETTINGS ON THE EXCHANGE WEBSITE.</li>
                      </ul>
                    </div>
                  )}

                  {serverConfig && !serverConfig.hasKeys && (
                    <div className="mb-4 p-2 bg-blue-500/10 border border-blue-500/30 rounded-sm">
                       <p className="text-[9px] text-blue-300 font-bold uppercase leading-tight">
                         Setup Required
                       </p>
                       <p className="text-[7px] text-blue-300/60 mt-1 uppercase">
                         Add BINANCE_API_KEY & SECRET in Settings to sync exchange.
                       </p>
                    </div>
                  )}

                   <div className="flex items-center justify-between mb-2">
                    <div className="flex flex-col">
                      <label className="text-[10px] uppercase font-bold opacity-60">BNB Commission Logic</label>
                      <span className="text-[7px] font-mono opacity-30 uppercase">Fee Opt: {useBNBFees ? '0.075%' : '0.100%'}</span>
                    </div>
                    <button 
                      onClick={() => setUseBNBFees(!useBNBFees)}
                      className={`w-8 h-4 rounded-full transition-colors relative ${useBNBFees ? 'bg-[#F27D26]' : 'bg-white/10'}`}
                    >
                      <div className={`absolute top-1 w-2 h-2 rounded-full bg-white transition-all ${useBNBFees ? 'right-1' : 'left-1'}`} />
                    </button>
                  </div>
                  <p className="text-[7px] font-mono opacity-20 uppercase italic leading-tight mt-2">
                    Enabled: Higher investment scale reduces recursive percentage impact (Simulated Whale Tiers).
                  </p>
                </div>

                {currentHolding && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-white/5 p-3 border border-white/10">
                      <p className="text-[8px] uppercase font-bold opacity-40 mb-1">Stop Loss At</p>
                      <p className="text-sm font-black text-rose-400 tabular-nums">
                        ${formatPrice(currentHolding.entryPrice * (1 - stopLossPercent / 100))}
                      </p>
                    </div>
                    <div className="bg-white/5 p-3 border border-white/10">
                      <p className="text-[8px] uppercase font-bold opacity-40 mb-1">Take Profit At</p>
                      <p className="text-sm font-black text-emerald-400 tabular-nums">
                        ${formatPrice(currentHolding.entryPrice * (1 + takeProfitPercent / 100))}
                      </p>
                    </div>
                  </div>
                )}
              </div>
          </section>
        </div>

        {/* Center/Right Column: Chart & Dashboard */}
        <div className="lg:col-span-3 flex flex-col gap-8">
          {/* Strategy Insight Bar - High Density Data Row */}
          <div className="bg-[#141414] text-white py-2 px-6 flex items-center justify-between border-l-4 border-[#F27D26] shadow-xl overflow-hidden relative">
             <div className="absolute top-0 right-0 p-1 opacity-5">
               <Zap size={60} />
             </div>
             
               <div className="flex items-center gap-8 relative z-10">
                  <div className="flex items-center gap-3">
                     <div className="flex flex-col">
                        <span className="text-[8px] uppercase font-bold text-[#F27D26] tracking-tighter">Selected Node</span>
                        <span className="text-sm font-black tracking-widest">{symbol}</span>
                     </div>
                  </div>
                  
                  <div className="h-8 w-px bg-white/10" />

                  <div className="flex gap-6">
                     <div className="flex flex-col">
                        <span className="text-[8px] uppercase font-bold opacity-40">AI Confidence</span>
                        <div className="flex items-center gap-2">
                           <span className="text-sm font-black tabular-nums">{strategy?.score || 0}<span className="text-[10px] opacity-20">/10</span></span>
                           <div className="flex gap-0.5">
                              {[...Array(10)].map((_, i) => (
                                 <div key={i} className={`w-1 h-3 rounded-[1px] ${i < (strategy?.score || 0) ? 'bg-[#F27D26]' : 'bg-white/10'}`} />
                              ))}
                           </div>
                        </div>
                     </div>

                     <div className="flex flex-col">
                        <span className="text-[8px] uppercase font-bold opacity-40">Trend Orientation</span>
                        <span className={`text-[10px] font-black uppercase ${strategy?.trend === 'UP' ? 'text-emerald-400' : 'text-rose-400'}`}>
                           {strategy?.trend || 'CALIBRATING...'}
                        </span>
                     </div>

                     <div className="flex flex-col">
                        <span className="text-[8px] uppercase font-bold opacity-40">MA Energy</span>
                        <span className="text-[10px] font-black uppercase">
                           {strategy?.confluence.emaCrossover === 'BULLISH' ? 'OVER-CROSS' : 'UNDER-CROSS'}
                        </span>
                     </div>

                     <div className="flex flex-col">
                        <span className="text-[8px] uppercase font-bold opacity-40">RSI Signal</span>
                        <span className="text-[10px] font-black uppercase">
                           {strategy?.confluence.rsi === 'OVERSOLD' ? 'BULLISH_DIV' : strategy?.confluence.rsi === 'OVERBOUGHT' ? 'BEARISH_DIV' : 'STABLE'}
                        </span>
                     </div>
                  </div>
               </div>

             <div className="hidden md:flex items-center gap-6 relative z-10">
                <div className="flex flex-col items-end">
                   <span className="text-[8px] uppercase font-bold opacity-40">Strategy Pulse</span>
                   <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-black px-2 py-0.5 rounded-sm ${
                        strategy?.overall === 'BUY' ? 'bg-emerald-500 text-white' : 
                        strategy?.overall === 'SELL' ? 'bg-rose-500 text-white' : 'bg-white/10 text-white/40'
                      }`}>
                        {strategy?.overall || 'IDLE'}
                      </span>
                   </div>
                </div>
             </div>
          </div>

          {/* Metrics Dashboard */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            <MetricBox 
              icon={<Wallet className={isRealMode ? 'text-rose-500' : 'text-[#F27D26]'} size={18} />}
              label="Portfolio Value"
              value={`$${equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              trend={pnl >= 0 ? 'up' : 'down'}
              subValue={
                <div className="flex items-center gap-2">
                   <span className="opacity-60">CASH: ${balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                   <button 
                     onClick={(e) => { e.stopPropagation(); resetAccount(); }}
                     className="text-[8px] bg-white/5 hover:bg-white/10 px-2 py-0.5 rounded transition-colors uppercase font-bold"
                   >
                     Reset
                   </button>
                </div>
              }
            />
            <MetricBox 
              icon={<TrendingUp className={isRealMode ? 'text-rose-500' : 'text-[#F27D26]'} size={18} />}
              label="Total Performance"
              value={`${pnl >= 0 ? '+' : ''}${pnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              trend={pnl >= 0 ? 'up' : 'down'}
              subValue={`${pnlPercent.toFixed(2)}% ROE`}
            />
            <MetricBox 
              icon={<Activity className={isRealMode ? 'text-rose-500' : 'text-[#F27D26]'} size={18} />}
              label="Active Risk"
              value={`$${holdings.reduce((sum, h) => sum + ((holdingPrices[h.symbol] || h.entryPrice) - h.entryPrice) * h.amount, 0).toFixed(2)}`}
              subValue="Unrealized P&L"
              trend={holdings.reduce((sum, h) => sum + ((holdingPrices[h.symbol] || h.entryPrice) - h.entryPrice) * h.amount, 0) >= 0 ? 'up' : 'down'}
            />
            <MetricBox 
              icon={<Zap className={isRealMode ? 'text-rose-500' : 'text-[#F27D26]'} size={18} />}
              label="Network Status"
              value={isSyncing ? "SYNCING..." : (isRealMode ? "LIVE" : "PAPER")}
              subValue={serverConfig?.exchange ? `${serverConfig.exchange.toUpperCase()} | ${holdings.length}/${maxConcurrentTrades} SLOTS` : "SIMULATION"}
            />
            <MetricBox 
              icon={<DollarSign className={isRealMode ? 'text-rose-500' : 'text-[#F27D26]'} size={18} />}
              label="Available Funds"
              value={`$${balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              subValue={isRealMode ? "Live Exchange USD" : "Simulated Capital"}
            />
            <MetricBox 
              icon={<Activity className={isRealMode ? 'text-rose-500' : 'text-[#F27D26]'} size={18} />}
              label="Budget Efficiency"
              value={`${(((equity - balance) / (equity || 1)) * 100).toFixed(1)}%`}
              subValue="Asset Allocation %"
            />
          </div>

          {/* Active Trades Table (Gemini Style) */}
          <section className="bg-white border-2 border-[#141414] shadow-[8px_8px_0px_0px_#141414] overflow-hidden">
            <div className="bg-[#141414] text-white p-4 flex items-center justify-between">
               <div className="flex items-center gap-3 text-[#F27D26]">
                 <Activity size={18} strokeWidth={3} />
                 <h2 className="font-mono text-xs uppercase tracking-[0.3em] font-bold text-white">Active Positions Engine</h2>
               </div>
               <div className="flex items-center gap-4">
                 <button 
                  onClick={liquidateAll}
                  disabled={holdings.length === 0}
                  className="text-[9px] font-black bg-rose-600 hover:bg-rose-700 text-white px-3 py-1 rounded-sm transition-all disabled:opacity-20"
                >
                  LIQUIDATE ALL POSITIONS
                </button>
               </div>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead className="bg-gray-50 border-b-2 border-gray-100 uppercase font-mono text-[9px] opacity-40">
                  <tr>
                    <th className="px-6 py-4 tracking-widest">Asset</th>
                    <th className="px-6 py-4 tracking-widest">Side</th>
                    <th className="px-6 py-4 tracking-widest">Size/Qty</th>
                    <th className="px-6 py-4 tracking-widest">Entry Price</th>
                    <th className="px-6 py-4 tracking-widest">Current Price</th>
                    <th className="px-6 py-4 tracking-widest">Unrealized P&L</th>
                    <th className="px-6 py-4 text-right tracking-widest">Action Control</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {holdings.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-16 text-center">
                        <div className="flex flex-col items-center gap-2 opacity-30">
                          <Zap size={24} />
                          <p className="text-xs font-mono uppercase tracking-[0.2em]">Awaiting signal confluence. No open vectors.</p>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    holdings.map((h, i) => {
                      const price = holdingPrices[h.symbol] || (h.symbol === symbol ? currentPrice : h.entryPrice) || h.entryPrice;
                      const pnlVal = (price - h.entryPrice) * h.amount;
                      const pnlPctVal = ((price - h.entryPrice) / h.entryPrice) * 100;
                      return (
                        <tr key={i} className="hover:bg-gray-50/50 transition-colors group cursor-pointer" onClick={() => setSymbol(h.symbol)}>
                          <td className="px-6 py-5">
                             <div className="flex items-center gap-2">
                               <div className={`w-1.5 h-1.5 rounded-full ${h.symbol === symbol ? 'bg-[#F27D26]' : 'bg-gray-300'}`} />
                               <span className="font-black text-sm uppercase tracking-tighter">{h.symbol.replace('USDT', '').replace('USD', '')}</span>
                             </div>
                          </td>
                          <td className="px-6 py-5">
                             <span className="text-[10px] font-black px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded-sm">LONG</span>
                          </td>
                          <td className="px-6 py-5 font-mono text-xs opacity-60">
                             {h.amount < 0.01 ? h.amount.toFixed(6) : h.amount.toFixed(4)}
                          </td>
                          <td className="px-6 py-5 font-mono text-xs opacity-60">
                             ${formatPrice(h.entryPrice)}
                          </td>
                          <td className="px-6 py-5 font-mono text-xs font-bold">
                             ${formatPrice(price)}
                          </td>
                          <td className={`px-6 py-5 font-black text-sm ${pnlVal >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                             {pnlVal >= 0 ? '+' : ''}${pnlVal.toFixed(2)}
                             <span className="text-[10px] ml-2 opacity-60">({pnlPctVal.toFixed(2)}%)</span>
                          </td>
                          <td className="px-6 py-5 text-right">
                             <button 
                               onClick={(e) => {
                                 e.stopPropagation();
                                 executeTrade('SELL', h.symbol, price, 'MANUAL_DOCK_CONTROL', h.id);
                               }}
                               className="bg-[#141414] text-white hover:bg-[#F27D26] px-4 py-1.5 text-[10px] font-black uppercase tracking-tighter transition-all"
                             >
                               Close Pos
                             </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Trade History & Command Logs */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
             <section className="bg-white border-2 border-[#141414] shadow-[8px_8px_0px_0px_#141414] overflow-hidden flex flex-col h-[400px]">
                <div className="bg-gray-50 border-b border-[#141414]/10 p-4 flex items-center justify-between">
                   <div className="flex items-center gap-2">
                     <History size={14} className="opacity-40" />
                     <h3 className="font-mono text-[10px] uppercase tracking-widest font-bold">Execution History</h3>
                   </div>
                   <button onClick={() => setTradeHistory([])} className="text-[9px] font-bold opacity-30 hover:opacity-100 uppercase transition-opacity">Clear All</button>
                </div>
                <div className="flex-grow overflow-y-auto custom-scrollbar">
                   <table className="w-full text-left border-collapse">
                      <thead className="bg-gray-50/50 sticky top-0 uppercase font-mono text-[8px] opacity-40 border-b">
                         <tr>
                            <th className="px-4 py-2">Asset/Time</th>
                            <th className="px-4 py-2">Side/Price</th>
                            <th className="px-4 py-2 text-right">P&L</th>
                         </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {tradeHistory.length === 0 ? (
                          <tr><td colSpan={3} className="px-4 py-12 text-center text-[10px] opacity-30 italic">No historical nodes recorded.</td></tr>
                        ) : (
                          tradeHistory.map((trade, i) => (
                            <tr key={i} className="hover:bg-gray-50/30 transition-colors">
                               <td className="px-4 py-3">
                                  <div className="flex flex-col">
                                     <span className="text-xs font-black">{trade.symbol.replace('USDT', '').replace('USD', '')}</span>
                                     <span className="text-[8px] opacity-40 uppercase">{new Date(trade.time).toLocaleTimeString()}</span>
                                  </div>
                               </td>
                               <td className="px-4 py-3">
                                  <div className="flex flex-col">
                                     <span className={`text-[10px] font-black ${trade.type === 'BUY' ? 'text-emerald-600' : 'text-rose-600'}`}>{trade.type}</span>
                                     <span className="text-[9px] font-mono opacity-60">${formatPrice(trade.price)}</span>
                                  </div>
                               </td>
                               <td className="px-4 py-3 text-right">
                                  {trade.type === 'SELL' && trade.pnl !== undefined ? (
                                    <div className={`flex flex-col ${trade.pnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                                       <span className="text-[11px] font-black">${trade.pnl.toFixed(2)}</span>
                                       <span className="text-[9px] font-bold opacity-60">{trade.pnlPct?.toFixed(2)}%</span>
                                    </div>
                                  ) : (
                                    <span className="text-[9px] opacity-30 font-mono italic">--</span>
                                  )}
                               </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                   </table>
                </div>
             </section>

          </div>
        </div>
      </div>
    </div>

          {/* Strategy Laboratory (Backtest Module) */}
          <div className={activeTab === 'BACKTEST' ? 'block' : 'hidden'}>
            <div className="w-full">
              <BacktestModule symbol={symbol} availableSymbols={availableSymbols} />
            </div>
          </div>
  </div>
</main>

      <footer className="max-w-7xl mx-auto mt-16 pt-8 border-t border-[#141414]/10 text-[10px] font-mono uppercase tracking-[0.4em] opacity-40 flex justify-between">
        <span>© 2026 TradeEdge Laboratory // Enterprise Core</span>
        <div className="flex items-center gap-4">
          <span>BACKEND: {serverStatus}</span>
          <span>Secure Ingress // Latency 14ms</span>
        </div>
      </footer>
    </div>
  );
}

const MetricBox = ({ icon, label, value, trend, subValue }: { icon: React.ReactNode, label: string, value: string, trend?: 'up' | 'down', subValue?: React.ReactNode }) => {
  return (
    <div className="bg-white border-2 border-[#141414] p-5 flex items-center justify-between group hover:bg-[#141414] hover:text-white transition-colors duration-300 font-sans">
      <div className="flex items-center gap-4">
        <div className="p-2.5 bg-[#141414] text-white group-hover:bg-[#F27D26] transition-colors">
          {icon}
        </div>
        <div>
          <p className="text-[11px] uppercase font-bold opacity-40 tracking-tighter group-hover:opacity-60">{label}</p>
          <div className="flex flex-col">
            <p className="text-3xl font-black tabular-nums tracking-tighter leading-none">{value}</p>
            {subValue && (
              <div className="mt-1 font-mono uppercase text-[9px] font-bold opacity-60">
                {subValue}
              </div>
            )}
          </div>
        </div>
      </div>
      {trend && (
        <div className={trend === 'up' ? 'text-emerald-600' : 'text-rose-600'}>
          {trend === 'up' ? <ArrowUpRight size={28} /> : <ArrowDownRight size={28} />}
        </div>
      )}
    </div>
  );
};
