import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { TrendingUp, Activity, ShieldAlert, ShieldCheck, Info, Wallet, DollarSign, ArrowUpRight, ArrowDownRight, Search, Zap, Loader2, History, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { fetchBinanceData, fetchLatestPrice, subscribeToTicker, fetchAllSymbols, fetchTopSymbolsByVolume, getPublicDataSourceSnapshot } from './services/binance';
import { calculateIndicators, evaluateStrategy, Candle, DEFAULT_STRATEGY_CONFIG, IndicatorResult, StrategyConfig, StrategySignal } from './services/indicators';
import { scanMarket, MarketScanResult } from './services/scanner';
import { BacktestModule } from './components/BacktestModule';

const STRATEGY_SIGNAL_INTERVAL = '1d';
const SCAN_SHORTLIST_SAFE_CAP = 2000;
const DEFAULT_BROAD_SCAN_LIMIT = 1500;
const DEFAULT_LIVE_QUOTE_ALLOWLIST_INPUT = 'USDT,USDC,FDUSD,BUSD,TUSD';

const CRITERIA_HELP: Record<string, string> = {
  autoEntryMinScore: 'Minimum strategy confidence required before opening a new position. Higher values reduce trade frequency and prioritize stronger setups.',
  liveMinOrderNotional: 'Minimum USDT notional value allowed per live order. Helps avoid exchange min-notional rejects and tiny low-quality entries.',
  macdFastPeriod: 'Fast EMA period used by MACD. Lower values react faster to price changes but can create more noise.',
  macdSlowPeriod: 'Slow EMA period used by MACD. Higher values smooth trend detection but react slower to reversals.',
  macdSignalPeriod: 'Signal-line EMA period for MACD cross detection. Larger values filter noise but delay entry/exit confirmation.',
  continuationScore: 'Score contribution for continuation-style trend behavior. Increase to favor momentum continuation over reversal setups.',
  rsiOverbought: 'RSI threshold considered overbought. Lowering it triggers caution earlier; increasing it allows stronger momentum runs.',
  rsiOversold: 'RSI threshold considered oversold. Raising it flags potential bounce setups sooner; lowering it requires deeper pullbacks.',
  scanIntervalSec: 'Seconds between automated market scan cycles. Lower values react faster but increase API load and rate-limit risk.',
  holdingPollIntervalSec: 'Seconds between live holding price refreshes. Lower values improve responsiveness but add frequent API calls.',
  maxSymbolsPerScan: 'Maximum number of symbols evaluated in one scan cycle while focused mode is active. Full Universe Mode ignores this cap and scans the full fetched list.',
  softCooldownMinutes: 'Cooldown after a skipped/rejected entry. Prevents immediate re-entry attempts on unstable symbols.',
  successCooldownMinutes: 'Cooldown after a successful close. Helps avoid overtrading the same symbol immediately after profit-taking.',
  paperLossCooldownMinutes: 'Cooldown after a paper-trading loss. Reduces repeated losses from rapid re-entry in bad conditions.',
  duplicateOrderLockoutSec: 'Minimum seconds before allowing a repeated order on the same side/symbol. Prevents accidental duplicate submissions.',
  liveEntryDelayMs: 'Delay between sequential live entry submissions. Reduces burst orders and margin/permission race failures.',
  liveEntriesPerCycle: 'Legacy setting retained for compatibility. Live scans now execute all eligible entries sequentially up to available slots, so signals are not deferred by a per-cycle cap.',
  minPaperAllocation: 'Minimum paper capital allocated per trade. Prevents unrealistically tiny paper positions in simulation mode.',
  lowMarginLockMinutes: 'Lock duration when free margin is too low. Temporarily pauses entries to avoid repeated margin rejects.',
  closeFailureLockMinutes: 'Lock duration after close-order failures. Prevents repeated close retries from spiraling into API churn.',
  hardFailureLockMinutes: 'Extended lock after severe repeated failures. Emergency brake to stabilize execution behavior.',
  trendSmaPeriod: 'SMA lookback used for broad trend context. Higher values emphasize long-term trend, lower values react faster.',
  rsiPeriod: 'Number of candles used to compute RSI. Lower values are more reactive; higher values are smoother and slower.',
  emaFastPeriod: 'Fast EMA period used in trend/momentum context scoring. Lower values increase sensitivity to short-term swings.',
  emaSlowPeriod: 'Slow EMA period used in trend/momentum context scoring. Higher values stabilize trend bias.',
  volumeLookback: 'Candles used for average volume baseline. Larger lookback smooths anomalies; smaller lookback is more reactive.',
  volumeMultiplier: 'Required volume intensity vs baseline for stronger signals. Higher values demand clearer participation.',
  supportLookback: 'Candles inspected to estimate support/resistance zones. Larger values use broader market structure.',
  nearSupportPercent: 'Distance threshold for detecting price near support. Higher values treat wider ranges as support proximity.',
  nearResistancePercent: 'Distance threshold for detecting price near resistance. Higher values mark resistance proximity earlier.',
  crossoverScore: 'Score weight assigned to MACD/EMA crossover events. Increase to prioritize crossover-driven entries.',
  contextTrendScore: 'Weight of trend context inside the final signal score. Higher values favor trend alignment.',
  contextVolumeScore: 'Weight of volume context inside the final signal score. Higher values require stronger volume confirmation.',
  contextMacdScore: 'Weight of MACD context inside the final score. Increase when MACD behavior should dominate decisions.',
  contextEmaScore: 'Weight of EMA context inside the final score. Increase when EMA structure should dominate decisions.',
  contextRsiScore: 'Weight of RSI context inside the final score. Increase when RSI regime should dominate decisions.',
  maxScore: 'Maximum theoretical score used for normalization/thresholding. Keep aligned with total weight design of your strategy.',
  liveQuoteAllowlistInput: 'Comma-separated quote assets allowed for live trading (for example USDT, USDC). Restricts tradable universe for safety.',
};

const PARAMETER_DEFAULTS = {
  maxConcurrentTrades: 15,
  takeProfitPercent: 8,
  stopLossPercent: 3.5,
  maxDrawdownPercent: 10,
  isDefensiveMode: false,
  autoEntryMinScore: 6,
  liveMinOrderNotional: 10,
  liveQuoteAllowlistInput: DEFAULT_LIVE_QUOTE_ALLOWLIST_INPUT,
  scanIntervalSec: 40,
  holdingPollIntervalSec: 10,
  maxSymbolsPerScan: DEFAULT_BROAD_SCAN_LIMIT,
  duplicateOrderLockoutSec: 45,
  liveEntryDelayMs: 900,
  liveEntriesPerCycle: 1,
  minPaperAllocation: 25,
  softCooldownMinutes: 30,
  successCooldownMinutes: 45,
  paperLossCooldownMinutes: 60,
  lowMarginLockMinutes: 15,
  closeFailureLockMinutes: 30,
  hardFailureLockMinutes: 120,
  fullUniverseMode: false,
} as const;

const NON_TRADABLE_QUOTE_BASES = new Set(['USDT', 'USDC', 'BUSD', 'TUSD', 'USDP', 'FDUSD']);

const getCompactUsdSymbolParts = (raw: string): { compact: string; base: string; quote: string } | null => {
  const compact = String(raw || '').toUpperCase().split(':')[0].replace('/', '');
  const match = compact.match(/^([A-Z0-9]+?)(USDT|USDC|USD)$/);
  if (!match) return null;
  return { compact, base: match[1], quote: match[2] };
};

const isNonTradableQuoteBaseSymbol = (raw: string) => {
  const parts = getCompactUsdSymbolParts(raw);
  if (!parts) return true;
  return /(?:USDT|USDC|USD){2,}$/.test(parts.compact) || NON_TRADABLE_QUOTE_BASES.has(parts.base);
};

const normalizeLiveFuturesSymbol = (raw: string) => {
  const normalized = String(raw || '').toUpperCase().replace(/[/:]/g, '');
  if (!normalized) return normalized;
  return normalized.endsWith('USD') && !normalized.endsWith('USDT') ? `${normalized}T` : normalized;
};

const getDirectionalEntryScore = (side: 'BUY' | 'SELL', score: number) => {
  return side === 'SELL' ? 10 - score : score;
};

const describeMacdHistogram = (state?: string) => {
  switch (state) {
    case 'BULLISH_ACCELERATION':
      return 'EXPANDING_UP';
    case 'BULLISH_FADE':
      return 'BULL_FADE';
    case 'BEARISH_ACCELERATION':
      return 'EXPANDING_DOWN';
    case 'BEARISH_FADE':
      return 'BEAR_FADE';
    default:
      return 'NEUTRAL';
  }
};

const describeHoldReason = (reason?: string) => {
  switch (reason) {
    case 'UNCLEAR_SETUP':
      return 'Why HOLD: unclear setup';
    case 'MOVE_ALREADY_HAPPENED':
      return 'Why HOLD: move already happened';
    case 'WEAK_MACD':
      return 'Why HOLD: weak MACD';
    case 'INSUFFICIENT_CONFIRMATION':
      return 'Why HOLD: insufficient confirmation';
    default:
      return '';
  }
};

const summarizeRejectReasons = (reasons?: string[], limit: number = 2) => {
  if (!reasons || reasons.length === 0) return '';
  return reasons.slice(0, limit).join(' | ');
};

const CriteriaInfoLabel = ({ text, detail }: { text: string; detail: string }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    if (!isOpen) return;

    const updatePopoverPosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;

      const rect = trigger.getBoundingClientRect();
      const maxWidth = Math.min(352, window.innerWidth - 32);
      const left = Math.max(16, Math.min(rect.left, window.innerWidth - maxWidth - 16));
      const top = rect.bottom + 8;
      setPopoverPos({ top, left });
    };

    updatePopoverPosition();
    window.addEventListener('resize', updatePopoverPosition);
    window.addEventListener('scroll', updatePopoverPosition, true);

    return () => {
      window.removeEventListener('resize', updatePopoverPosition);
      window.removeEventListener('scroll', updatePopoverPosition, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setIsOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  return (
    <span className="relative inline-flex items-center gap-1">
      <span>{text}</span>
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setIsOpen(prev => !prev);
        }}
        aria-label={`${text} details`}
        className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full border border-cyan-400/60 bg-cyan-500/15 px-1.5 text-[10px] font-black leading-none text-cyan-200 hover:bg-cyan-500/25"
      >
        @i
      </button>
      {isOpen && popoverPos && createPortal(
        <span
          ref={popoverRef}
          className="fixed z-[9999] w-[min(28rem,calc(100vw-2rem))] rounded-sm border border-cyan-400/40 bg-[#0a1a20] px-4 py-3.5 text-[16px] normal-case leading-relaxed text-cyan-100 shadow-[0_8px_32px_rgba(0,0,0,0.8)]"
          style={{ top: popoverPos.top, left: popoverPos.left }}
        >
          <span className="mb-2 block text-[14px] font-black uppercase tracking-wide text-cyan-300">{text}</span>
          <span>{detail}</span>
        </span>,
        document.body
      )}
    </span>
  );
};

export default function App() {
  const [activeTab, setActiveTab] = useState<'LIVE' | 'BACKTEST'>('LIVE');
  const [data, setData] = useState<Candle[]>([]);
  const [indicators, setIndicators] = useState<IndicatorResult | null>(null);
  const [strategy, setStrategy] = useState<StrategySignal | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [authDegradedMessage, setAuthDegradedMessage] = useState<string | null>(null);
  const [syncDetails, setSyncDetails] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [marketPicks, setMarketPicks] = useState<MarketScanResult[]>([]);
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [availableSymbols, setAvailableSymbols] = useState<{ label: string, value: string }[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [stopLossPercent, setStopLossPercent] = useState(() => {
    const saved = localStorage.getItem('te_stop_loss_percent');
    return saved ? (parseFloat(saved) || 3.5) : 3.5;
  });
  const [takeProfitPercent, setTakeProfitPercent] = useState(() => {
    const saved = localStorage.getItem('te_take_profit_percent');
    return saved ? (parseFloat(saved) || 8) : 8;
  });
  const [autoEntryMinScore, setAutoEntryMinScore] = useState(() => {
    const saved = localStorage.getItem('te_auto_entry_min_score');
    return saved ? (parseFloat(saved) || 2) : 2;
  });
  const [liveMinOrderNotional, setLiveMinOrderNotional] = useState(() => {
    const saved = localStorage.getItem('te_live_min_order_notional');
    return saved ? (parseFloat(saved) || 10) : 10;
  });
  const [liveQuoteAllowlistInput, setLiveQuoteAllowlistInput] = useState(() => {
    const saved = localStorage.getItem('te_live_quote_allowlist');
    const migrated = localStorage.getItem('te_live_quote_allowlist_migrated_v2') === '1';
    if (!saved) {
      localStorage.setItem('te_live_quote_allowlist_migrated_v2', '1');
      localStorage.setItem('te_live_quote_allowlist', DEFAULT_LIVE_QUOTE_ALLOWLIST_INPUT);
      return DEFAULT_LIVE_QUOTE_ALLOWLIST_INPUT;
    }

    const normalized = saved
      .split(',')
      .map(value => value.trim().toUpperCase())
      .filter(Boolean)
      .join(',');

    if (!migrated && normalized === 'USDT,USDC') {
      localStorage.setItem('te_live_quote_allowlist_migrated_v2', '1');
      localStorage.setItem('te_live_quote_allowlist', DEFAULT_LIVE_QUOTE_ALLOWLIST_INPUT);
      return DEFAULT_LIVE_QUOTE_ALLOWLIST_INPUT;
    }

    localStorage.setItem('te_live_quote_allowlist_migrated_v2', '1');
    return normalized || DEFAULT_LIVE_QUOTE_ALLOWLIST_INPUT;
  });
  const [scanIntervalSec, setScanIntervalSec] = useState(() => {
    const saved = localStorage.getItem('te_scan_interval_sec');
    return saved ? (parseInt(saved, 10) || 40) : 40;
  });
  const [holdingPollIntervalSec, setHoldingPollIntervalSec] = useState(() => {
    const saved = localStorage.getItem('te_holding_poll_interval_sec');
    return saved ? Math.max(10, parseInt(saved, 10) || 10) : 10;
  });
  const [maxSymbolsPerScan, setMaxSymbolsPerScan] = useState(() => {
    const saved = localStorage.getItem('te_max_symbols_per_scan');
    const migrated = localStorage.getItem('te_max_symbols_scan_migrated_v2') === '1';
    const migratedSafeCap = localStorage.getItem('te_max_symbols_scan_migrated_v3') === '1';
    const revertedBroadScans = localStorage.getItem('te_max_symbols_scan_reverted_v4') === '1';
    if (!saved) {
      localStorage.setItem('te_max_symbols_scan_migrated_v2', '1');
      localStorage.setItem('te_max_symbols_scan_reverted_v4', '1');
      return DEFAULT_BROAD_SCAN_LIMIT;
    }

    const parsed = parseInt(saved, 10) || DEFAULT_BROAD_SCAN_LIMIT;
    // One-time migration: old default 60 was too restrictive for full-universe scans.
    if (!migrated && parsed === 60) {
      localStorage.setItem('te_max_symbols_scan_migrated_v2', '1');
      localStorage.setItem('te_max_symbols_scan_reverted_v4', '1');
      localStorage.setItem('te_max_symbols_per_scan', String(DEFAULT_BROAD_SCAN_LIMIT));
      return DEFAULT_BROAD_SCAN_LIMIT;
    }

    if (!revertedBroadScans && migratedSafeCap && parsed === 120) {
      localStorage.setItem('te_max_symbols_scan_reverted_v4', '1');
      localStorage.setItem('te_max_symbols_per_scan', String(DEFAULT_BROAD_SCAN_LIMIT));
      return DEFAULT_BROAD_SCAN_LIMIT;
    }

    localStorage.setItem('te_max_symbols_scan_migrated_v2', '1');
    localStorage.setItem('te_max_symbols_scan_reverted_v4', '1');
    return Math.max(20, Math.min(SCAN_SHORTLIST_SAFE_CAP, parsed));
  });
  const [duplicateOrderLockoutSec, setDuplicateOrderLockoutSec] = useState(() => {
    const saved = localStorage.getItem('te_duplicate_order_lockout_sec');
    return saved ? (parseInt(saved, 10) || 15) : 15;
  });
  const [liveEntryDelayMs, setLiveEntryDelayMs] = useState(() => {
    const saved = localStorage.getItem('te_live_entry_delay_ms');
    return saved ? (parseInt(saved, 10) || 400) : 400;
  });
  const [liveEntriesPerCycle, setLiveEntriesPerCycle] = useState(() => {
    const saved = localStorage.getItem('te_live_entries_per_cycle');
    return saved ? Math.max(1, parseInt(saved, 10) || 3) : 3;
  });
  const [minPaperAllocation, setMinPaperAllocation] = useState(() => {
    const saved = localStorage.getItem('te_min_paper_allocation');
    return saved ? (parseFloat(saved) || 10) : 10;
  });
  const [softCooldownMinutes, setSoftCooldownMinutes] = useState(() => {
    const saved = localStorage.getItem('te_soft_cooldown_minutes');
    return saved ? (parseInt(saved, 10) || 2) : 2;
  });
  const [successCooldownMinutes, setSuccessCooldownMinutes] = useState(() => {
    const saved = localStorage.getItem('te_success_cooldown_minutes');
    return saved ? (parseInt(saved, 10) || 5) : 5;
  });
  const [paperLossCooldownMinutes, setPaperLossCooldownMinutes] = useState(() => {
    const saved = localStorage.getItem('te_paper_loss_cooldown_minutes');
    return saved ? (parseInt(saved, 10) || 30) : 30;
  });
  const [lowMarginLockMinutes, setLowMarginLockMinutes] = useState(() => {
    const saved = localStorage.getItem('te_low_margin_lock_minutes');
    return saved ? (parseInt(saved, 10) || 2) : 2;
  });
  const [closeFailureLockMinutes, setCloseFailureLockMinutes] = useState(() => {
    const saved = localStorage.getItem('te_close_failure_lock_minutes');
    return saved ? (parseInt(saved, 10) || 5) : 5;
  });
  const [hardFailureLockMinutes, setHardFailureLockMinutes] = useState(() => {
    const saved = localStorage.getItem('te_hard_failure_lock_minutes');
    return saved ? (parseInt(saved, 10) || 15) : 15;
  });
  const [showExtraCriteria, setShowExtraCriteria] = useState(() => {
    return localStorage.getItem('te_show_extra_criteria') === '1';
  });
  const [fullUniverseMode, setFullUniverseMode] = useState(() => {
    return localStorage.getItem('te_scan_full_universe_mode') === '1';
  });
  const [strategyConfig, setStrategyConfig] = useState<StrategyConfig>(() => {
    const saved = localStorage.getItem('te_strategy_config');
    if (!saved) return DEFAULT_STRATEGY_CONFIG;
    try {
      return { ...DEFAULT_STRATEGY_CONFIG, ...JSON.parse(saved) };
    } catch {
      return DEFAULT_STRATEGY_CONFIG;
    }
  });
  const [nextScanSec, setNextScanSec] = useState(() => {
    const saved = localStorage.getItem('te_scan_interval_sec');
    return saved ? (parseInt(saved, 10) || 40) : 40;
  });
  
  const filteredSymbols = availableSymbols.filter(s => 
    s.label.toLowerCase().includes(searchQuery.toLowerCase()) || 
    s.value.toLowerCase().includes(searchQuery.toLowerCase())
  ).slice(0, 300); // increased limit for broader discovery
  const liveQuoteAllowlist = liveQuoteAllowlistInput
    .split(',')
    .map(value => value.trim().toUpperCase())
    .filter(Boolean);
  
  // Persistence-enabled state
  const [balance, setBalance] = useState(() => {
    const saved = localStorage.getItem('te_balance');
    return saved ? (parseFloat(saved) || 800) : 800;
  });
  const [availableFunds, setAvailableFunds] = useState(() => {
    const saved = localStorage.getItem('te_available_funds');
    return saved ? (parseFloat(saved) || 800) : 800;
  });
  
  interface Holding {
    id: string;
    symbol: string;
    displaySymbol?: string;
    exchange?: string;
    contracts?: number;
    amount: number;
    side: 'LONG' | 'SHORT';
    entryPrice: number;
    markPrice?: number;
    notional?: number;
    initialMargin?: number;
    unrealizedPnl?: number;
    initialAmount?: number;
    stopPrice?: number;
    tp1Price?: number;
    tp2Price?: number;
    trailingStopPrice?: number;
    trailingBufferPct?: number;
    highestPrice?: number;
    lowestPrice?: number;
    time: string;
  }

  type ActivePositionSortKey =
    | 'exchange'
    | 'side'
    | 'symbol'
    | 'contracts'
    | 'entryPrice'
    | 'markPrice'
    | 'margin'
    | 'notional'
    | 'unrealizedPnl'
    | 'pnlPct'
    | 'action';

  type ActivePositionSortDirection = 'asc' | 'desc';

  interface ActivePositionSortRule {
    key: ActivePositionSortKey;
    direction: ActivePositionSortDirection;
  }

  type ExecutionStatus = 'FILLED' | 'SUBMITTED' | 'SKIPPED' | 'FAILED';
  interface TradeEvent {
    type: 'BUY' | 'SELL';
    symbol: string;
    price: number;
    entryPrice?: number;
    amount: number;
    time: string;
    reason?: string;
    pnl?: number;
    pnlPct?: number;
    status?: ExecutionStatus;
    cycleId?: number;
  }

  interface SystemLogEntry {
    time: string;
    message: string;
    type: 'info' | 'success' | 'warning';
    groupKey: string;
    repeatCount: number;
  }

  type MarketPickLifecycle = {
    label: 'Signal Found' | 'Order Submitted' | 'Exchange Confirmed' | 'Watching';
    className: string;
  };

  type ScanBlockedSignal = {
    symbol: string;
    side: 'BUY' | 'SELL';
    score: number;
    priorityRank: number;
    reason: string;
  };

  type ScanDeferredSignal = {
    symbol: string;
    side: 'BUY' | 'SELL';
    score: number;
    priorityRank: number;
  };

  const [holdings, setHoldings] = useState<Holding[]>(() => {
    const saved = localStorage.getItem('te_holdings');
    if (!saved) return [];
    try {
      const parsed = JSON.parse(saved);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr.map((h: any) => ({
        ...h,
        side: h?.side === 'SHORT' ? 'SHORT' : 'LONG',
      }));
    } catch {
      return [];
    }
  });
  const [activePositionSortRules, setActivePositionSortRules] = useState<ActivePositionSortRule[]>([]);
  
  const [tradeHistory, setTradeHistory] = useState<TradeEvent[]>(() => {
    const saved = localStorage.getItem('te_history');
    try {
      const parsed = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed)
        ? parsed.map((t: TradeEvent) => ({ ...t, status: t.status || 'FILLED' }))
        : [];
    } catch {
      return [];
    }
  });
  
  const [autoTrade, setAutoTrade] = useState(false);
  const [useBNBFees, setUseBNBFees] = useState(() => {
    const saved = localStorage.getItem('te_use_bnb_fees');
    return saved !== null ? saved === 'true' : true;
  });
  const [isRealMode, setIsRealMode] = useState(() => {
    const saved = localStorage.getItem('te_real_mode');
    return saved !== null ? saved === 'true' : false;
  });
  const [showSyncError, setShowSyncError] = useState(true);
  const [maxConcurrentTrades, setMaxConcurrentTrades] = useState(() => {
    const saved = localStorage.getItem('te_max_concurrent_trades');
    return saved ? (parseInt(saved, 10) || 15) : 15;
  });
  const [maxDrawdownPercent, setMaxDrawdownPercent] = useState(() => {
    const saved = localStorage.getItem('te_max_drawdown_percent');
    return saved ? (parseFloat(saved) || 10) : 10;
  });
  const [isDefensiveMode, setIsDefensiveMode] = useState(() => {
    const saved = localStorage.getItem('te_is_defensive_mode');
    return saved !== null ? saved === 'true' : false;
  });
  const [systemLogs, setSystemLogs] = useState<SystemLogEntry[]>([]);
  const [holdingPrices, setHoldingPrices] = useState<Record<string, number>>({});
  const [liveUnrealizedPnl, setLiveUnrealizedPnl] = useState(0);
  const [cooldowns, setCooldowns] = useState<Record<string, number>>({});
  const [isSyncing, setIsSyncing] = useState(false);
  const [serverStatus, setServerStatus] = useState<'IDLE' | 'OK' | 'ERROR'>('IDLE');
  const [serverConfig, setServerConfig] = useState<{ 
    realTradingEnabled: boolean, 
    hasKeys: boolean, 
    outboundIp?: string,
    exchange?: string,
    type?: string,
    binanceRouteHealth?: {
      positions?: string,
      orders?: string,
      updatedAt?: number,
    }
  } | null>(null);
  const [isBotActive, setIsBotActive] = useState(false);
  const [scanExecutionStats, setScanExecutionStats] = useState({ cycleId: 0, attempted: 0, filled: 0, failed: 0, skipped: 0 });
  const [scanExecutionTotals, setScanExecutionTotals] = useState({ attempted: 0, filled: 0, failed: 0, skipped: 0 });
  const [executionFeedback, setExecutionFeedback] = useState<{ type: 'info' | 'success' | 'warning', message: string } | null>(null);
  const [entryLockUntil, setEntryLockUntil] = useState(0);
  const lastRateLimitWarnAtRef = React.useRef(0);
  const dismissedSyncErrorRef = React.useRef<{ message: string; until: number } | null>(null);

  // Auto-dismiss toast after 8s for warnings/errors, 4s for success/info
  React.useEffect(() => {
    if (!executionFeedback) return;
    const delay = executionFeedback.type === 'warning' ? 8000 : 4000;
    const t = setTimeout(() => setExecutionFeedback(null), delay);
    return () => clearTimeout(t);
  }, [executionFeedback]);
  const tradeLockout = React.useRef<Set<string>>(new Set());
  const isSyncingRef = React.useRef(false);
  const syncRealBalanceRef = React.useRef<() => Promise<boolean>>(async () => false);
  const scanningRef = React.useRef(false);
  const rateLimitedUntilRef = React.useRef(0);
  const RATE_LIMIT_UNTIL_KEY = 'te_rate_limited_until';
  const knownUnsupportedLiveSymbols = React.useMemo(() => new Set(['NMRUSDC', 'KGSTUSDT']), []);
  const unsupportedScanSymbolsRef = React.useRef<Record<string, number>>({});
  const UNSUPPORTED_SCAN_SYMBOLS_KEY = 'te_unsupported_scan_symbols';
  const liveTradableSymbolsRef = React.useRef<Set<string>>(new Set());
  const liveTradableSymbolsFetchedAtRef = React.useRef(0);
  const currentScanCycleRef = React.useRef(0);
  const entryLockUntilRef = React.useRef(0);
  const lastScanSkipLogRef = React.useRef<Record<string, number>>({});
  
  // Refs for scan logic to avoid dependency loops
  const holdingsRef = React.useRef(holdings);
  const autoTradeRef = React.useRef(autoTrade);
  const maxConcurrentTradesRef = React.useRef(maxConcurrentTrades);

  React.useEffect(() => {
    holdingsRef.current = holdings;
    autoTradeRef.current = autoTrade;
    maxConcurrentTradesRef.current = maxConcurrentTrades;
  }, [holdings, autoTrade, maxConcurrentTrades]);

  React.useEffect(() => {
    // On boot: restore autonomous mode preference from localStorage
    const savedAutoTrade = localStorage.getItem('te_auto_trade') === 'true';
    autoTradeRef.current = savedAutoTrade;
    setAutoTrade(savedAutoTrade);
  }, []);

  React.useEffect(() => {
    entryLockUntilRef.current = entryLockUntil;
  }, [entryLockUntil]);

  const setRateLimitUntil = React.useCallback((until: number) => {
    rateLimitedUntilRef.current = until;
    if (until > Date.now()) {
      localStorage.setItem(RATE_LIMIT_UNTIL_KEY, String(until));
    } else {
      localStorage.removeItem(RATE_LIMIT_UNTIL_KEY);
    }
  }, []);

  React.useEffect(() => {
    const saved = parseInt(localStorage.getItem(RATE_LIMIT_UNTIL_KEY) || '0', 10);
    if (Number.isFinite(saved) && saved > Date.now()) {
      rateLimitedUntilRef.current = saved;
    } else {
      localStorage.removeItem(RATE_LIMIT_UNTIL_KEY);
    }
  }, []);

  const pruneUnsupportedScanSymbols = React.useCallback(() => {
    const now = Date.now();
    const nextEntries = Object.entries(unsupportedScanSymbolsRef.current as Record<string, number>)
      .filter(([, until]) => Number.isFinite(until) && until > now);
    unsupportedScanSymbolsRef.current = Object.fromEntries(nextEntries);
    if (nextEntries.length > 0) {
      localStorage.setItem(UNSUPPORTED_SCAN_SYMBOLS_KEY, JSON.stringify(unsupportedScanSymbolsRef.current));
    } else {
      localStorage.removeItem(UNSUPPORTED_SCAN_SYMBOLS_KEY);
    }
    return unsupportedScanSymbolsRef.current;
  }, []);

  const blockUnsupportedScanSymbol = React.useCallback((value: string, ttlMs = 12 * 60 * 60 * 1000) => {
    const normalized = String(value || '').toUpperCase().replace(/[/:]/g, '');
    if (!normalized) return;
    unsupportedScanSymbolsRef.current = {
      ...unsupportedScanSymbolsRef.current,
      [normalized]: Date.now() + ttlMs,
    };
    localStorage.setItem(UNSUPPORTED_SCAN_SYMBOLS_KEY, JSON.stringify(unsupportedScanSymbolsRef.current));
  }, []);

  React.useEffect(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(UNSUPPORTED_SCAN_SYMBOLS_KEY) || '{}') as Record<string, number>;
      if (parsed && typeof parsed === 'object') {
        unsupportedScanSymbolsRef.current = parsed;
        pruneUnsupportedScanSymbols();
      }
    } catch {
      localStorage.removeItem(UNSUPPORTED_SCAN_SYMBOLS_KEY);
    }
  }, [pruneUnsupportedScanSymbols]);

  const isUnsupportedLiveScanSymbol = React.useCallback((value: string) => {
    const normalized = String(value || '').toUpperCase().replace(/[/:]/g, '');
    if (!normalized) return false;
    if (knownUnsupportedLiveSymbols.has(normalized)) return true;
    const blockedUntil = pruneUnsupportedScanSymbols()[normalized] || 0;
    return blockedUntil > Date.now();
  }, [knownUnsupportedLiveSymbols, pruneUnsupportedScanSymbols]);

  React.useEffect(() => {
    if (!autoTrade) {
      scanningRef.current = false;
      setScanning(false);
      setIsBotActive(false);
      setScanProgress({ current: 0, total: 0 });
    }
  }, [autoTrade]);

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
    const normalized = message.startsWith('SYNC SUCCESS:')
      ? 'SYNC SUCCESS'
      : message.startsWith('INITIATING EXCHANGE HANDSHAKE')
        ? 'INITIATING EXCHANGE HANDSHAKE'
        : message;
    const groupKey = `${type}:${normalized}`;

    setSystemLogs(prev => {
      const now = new Date().toLocaleTimeString();
      if (prev.length > 0 && prev[0].groupKey === groupKey) {
        const updatedTop: SystemLogEntry = {
          ...prev[0],
          time: now,
          message,
          repeatCount: prev[0].repeatCount + 1,
        };
        return [updatedTop, ...prev.slice(1)].slice(0, 30);
      }

      const nextEntry: SystemLogEntry = {
        time: now,
        message,
        type,
        groupKey,
        repeatCount: 1,
      };
      return [nextEntry, ...prev].slice(0, 30);
    });
  }, []);

  const pushTradeEvent = React.useCallback((event: TradeEvent) => {
    const normalized = { ...event, status: event.status || 'FILLED' };
    setTradeHistory(prev => [normalized, ...prev]);

    setScanExecutionTotals(prev => {
      const next = { ...prev, attempted: prev.attempted + 1 };
      if (normalized.status === 'FILLED' || normalized.status === 'SUBMITTED') next.filled += 1;
      else if (normalized.status === 'FAILED') next.failed += 1;
      else next.skipped += 1;
      return next;
    });

    if (typeof normalized.cycleId === 'number' && normalized.cycleId > 0) {
      setScanExecutionStats(prev => {
        if (normalized.cycleId !== prev.cycleId) return prev;
        const next = { ...prev, attempted: prev.attempted + 1 };
        if (normalized.status === 'FILLED' || normalized.status === 'SUBMITTED') next.filled += 1;
        else if (normalized.status === 'FAILED') next.failed += 1;
        else next.skipped += 1;
        return next;
      });
    }
  }, []);

  const pushScanSkipEvent = React.useCallback((reason: string, cycleId: number) => {
    const now = Date.now();
    const lastTs = lastScanSkipLogRef.current[reason] || 0;
    // Prevent execution history spam for repeating scan-level skips.
    if (now - lastTs < 45000) return;
    lastScanSkipLogRef.current[reason] = now;

    pushTradeEvent({
      type: 'BUY',
      symbol: 'SCAN',
      price: 0,
      amount: 0,
      time: new Date().toISOString(),
      reason,
      status: 'SKIPPED',
      cycleId,
    });
  }, [pushTradeEvent]);

  const reportSyncError = React.useCallback((message: string | null) => {
    if (!message) {
      setSyncError(null);
      return;
    }
    const dismissed = dismissedSyncErrorRef.current;
    if (dismissed && dismissed.message === message && dismissed.until > Date.now()) {
      return;
    }
    setSyncError(message);
  }, []);

  const dismissSyncError = React.useCallback(() => {
    if (syncError) {
      dismissedSyncErrorRef.current = {
        message: syncError,
        until: Date.now() + 2 * 60 * 1000,
      };
    }
    setSyncError(null);
  }, [syncError]);

  const syncRealBalance = React.useCallback(async () => {
    if (isSyncingRef.current) return false;
    if (rateLimitedUntilRef.current > Date.now()) {
      const retryTime = new Date(rateLimitedUntilRef.current).toLocaleTimeString();
      const message = `BINANCE RATE LIMITED: IP temporarily banned by Binance. Retry at ${retryTime}. (Too many API requests were made recently.)`;
      const now = Date.now();
      const shouldNotify = now - lastRateLimitWarnAtRef.current > 30000;
      reportSyncError(message);
      if (shouldNotify) {
        lastRateLimitWarnAtRef.current = now;
        setExecutionFeedback({ type: 'warning', message });
        addLog(message, 'warning');
      }
      return false;
    }
    if (entryLockUntilRef.current > Date.now()) {
      const retryTime = new Date(entryLockUntilRef.current).toLocaleTimeString();
      const message = `Live trading disabled until ${retryTime}`;
      reportSyncError(message);
      setExecutionFeedback({ type: 'warning', message });
      addLog(message, 'warning');
      return false;
    }
    isSyncingRef.current = true;
    setIsSyncing(true);
    addLog(`INITIATING EXCHANGE HANDSHAKE...`, 'info');
    
    try {
      const resp = await fetch('/api/binance/balance');
      if (!resp.ok) {
        const errorData = await resp.json().catch(() => ({}));
        let message = errorData.message || `Server responded with ${resp.status}`;
        const normalizedMessage = String(message).toLowerCase();
        const authBlockedUntil = Number(errorData.blockedUntil || 0);
        const hasAuthBlock = Number.isFinite(authBlockedUntil) && authBlockedUntil > Date.now();
        const authRetryAt = hasAuthBlock ? new Date(authBlockedUntil).toLocaleTimeString() : null;
        const isAuthFailedStatus = errorData.status === 'auth_failed';
        const isAuthError =
          normalizedMessage.includes('-2015') ||
          normalizedMessage.includes('-2014') ||
          normalizedMessage.includes('invalid api-key') ||
          normalizedMessage.includes('api-key format invalid') ||
          normalizedMessage.includes('signature for this request is not valid') ||
          normalizedMessage.includes('invalid signature') ||
          normalizedMessage.includes('ip address') ||
          normalizedMessage.includes('whitelist') ||
          normalizedMessage.includes('enable futures');

        if (resp.status === 429 || errorData.status === 'rate_limited') {
          const bannedUntil: number = errorData.bannedUntil || (Date.now() + (errorData.retryAfterMs || 60000));
          setRateLimitUntil(bannedUntil);
          const retryTime = new Date(bannedUntil).toLocaleTimeString();
          message = `BINANCE RATE LIMITED: IP temporarily banned by Binance. Retry at ${retryTime}. (Too many API requests were made recently.)`;
        } else if (isAuthFailedStatus || isAuthError) {
          const currentIp = serverConfig?.outboundIp || 'Unknown';
          const retrySuffix = authRetryAt ? ` Retry at ${authRetryAt}.` : '';
          message = authRetryAt
            ? `Live trading disabled until ${authRetryAt}`
            : `Live trading disabled until ${(new Date(authBlockedUntil || Date.now() + 60000)).toLocaleTimeString()}`;
          setIsRealMode(false);
          setAutoTrade(false);
          if (hasAuthBlock) {
            setEntryLockUntil(authBlockedUntil);
            setRateLimitUntil(authBlockedUntil);
          }
        } else if (message.includes('-1021')) {
          message = 'TIMESTAMP REJECTED. Your local clock may be out of sync with exchange servers.';
        }

        reportSyncError(message);
        setExecutionFeedback({ type: 'warning', message });
        return false;
      }
      
      const data = await resp.json();
      if (data.status === 'success') {
        const liveEquity = Number(data.equity);
        const usdt = Number(data?.balance?.USDT || 0);
        const liveAvailable = Number(data?.availableBalance);
        const isAuthDegraded = data?.authDegraded === true;
        const degradedMsg = String(data?.authDegradedMessage || '').trim();
        const syncedBalance = Number.isFinite(liveEquity) && liveEquity > 0 ? liveEquity : usdt;
        const syncedAvailable = Number.isFinite(liveAvailable) && liveAvailable >= 0 ? liveAvailable : usdt;
        const syncedUnrealized = Number(data?.unrealizedPnl);
        const nextFilteredSyncSymbols = Array.isArray(data?.filteredSymbols)
          ? data.filteredSymbols
              .map((entry: any) => ({
                symbol: String(entry?.symbol || '').toUpperCase(),
                reason: String(entry?.reason || 'quote asset cross or malformed symbol'),
              }))
              .filter((entry: { symbol: string; reason: string }) => Boolean(entry.symbol))
          : [];
        setBalance(syncedBalance);
        setAvailableFunds(syncedAvailable);
        setLiveUnrealizedPnl(Number.isFinite(syncedUnrealized) ? syncedUnrealized : 0);
        setFilteredSyncSymbols(nextFilteredSyncSymbols);
        setServerConfig(prev => prev ? {
          ...prev,
          binanceRouteHealth: data?.binanceRouteHealth || prev.binanceRouteHealth,
        } : prev);
        setAuthDegradedMessage(isAuthDegraded
          ? (degradedMsg || 'Binance futures auth is degraded (-2015): API key, IP whitelist, or permissions are incomplete.')
          : null);

        // Hard live safety: pause autonomous mode before scanner/order logic when margin is below minimum order notional.
        if (isRealMode && autoTradeRef.current && syncedAvailable < liveMinOrderNotional) {
          const lockMs = lowMarginLockMinutes * 60 * 1000;
          autoTradeRef.current = false;
          setAutoTrade(false);
          setEntryLockUntil(prev => Math.max(prev, Date.now() + lockMs));
          const lowMarginMsg = `AUTONOMOUS PAUSED: Free margin $${syncedAvailable.toFixed(2)} below minimum order $${liveMinOrderNotional.toFixed(2)}.`;
          addLog(lowMarginMsg, 'warning');
          setExecutionFeedback({ type: 'warning', message: lowMarginMsg });
        }
        
        let freshHoldings: Holding[] = [];
        if (data.positions) {
          const toCompactSymbol = (raw: string) => {
            const up = String(raw || '').toUpperCase();
            if (!up) return up;

            // Binance futures symbols often arrive as BASE/QUOTE:SETTLE.
            // Normalize them to compact trading symbols like TRXUSDT.
            const [pair] = up.split(':');
            return pair.replace('/', '');
          };

          const positionCount = Object.keys(data.positions).length;
          console.log(`[TradeEdge SYNC] Backend returned ${positionCount} positions`);
          if (positionCount > 0) {
            console.log(`[TradeEdge SYNC] Position keys: ${Object.keys(data.positions).join(', ')}`);
          }

          freshHoldings = Object.entries(data.positions).map(([coin, info]: [string, any]): Holding | null => {
            const coinUpper = coin.toUpperCase();
            const fromInfoSymbol = toCompactSymbol(info?.symbol || '');
            let normalizedSymbol = fromInfoSymbol || (coinUpper.endsWith('USD') || coinUpper.endsWith('USDT') || coinUpper.endsWith('USDC')
              ? coinUpper
              : (data.exchange === 'binance' ? `${coinUpper}USDT` : `${coinUpper}USD`));
            const symbolMatch = getCompactUsdSymbolParts(normalizedSymbol);

            // STRICT VALIDATION: Reject malformed symbols and quote-asset crosses like USDCUSDT.
            if (!symbolMatch || isNonTradableQuoteBaseSymbol(normalizedSymbol)) {
              console.warn(`[TradeEdge] Rejecting malformed symbol: "${normalizedSymbol}" (doesn't match valid trading pair format)`);
              return null;
            }

            // PRICE RESOLUTION: Do not default to 1 as it creates "Ghost Equity"
            const price = marketPicks.find(p => p.symbol === normalizedSymbol)?.lastPrice || 
                          holdingPrices[normalizedSymbol] || 0; // Default 0
            
            // Final safety filter for 'T' assets if exchange is Gemini
            if (data.exchange === 'gemini' && normalizedSymbol.endsWith('TUSD') && normalizedSymbol !== 'USDTUSD') {
              return null;
            }

            const amount = Number(info?.amount || 0);
            if (!(amount > 0)) return null;

            const previousHolding = holdingsRef.current.find(prev => prev.symbol === normalizedSymbol && prev.side === (info.side === 'SHORT' ? 'SHORT' : 'LONG'));

            return {
              id: `${normalizedSymbol}_${info.side || 'LONG'}`,
              symbol: normalizedSymbol,
              displaySymbol: typeof info?.symbol === 'string' && info.symbol.includes('/') ? info.symbol : undefined,
              exchange: info?.exchange || (data.exchange ? String(data.exchange).charAt(0).toUpperCase() + String(data.exchange).slice(1) : undefined),
              contracts: Number(info?.contracts || info?.amount || 0) || undefined,
              amount,
              side: (info.side === 'SHORT' ? 'SHORT' : 'LONG') as 'LONG' | 'SHORT',
              entryPrice: Number(info.entryPrice) > 0 ? Number(info.entryPrice) : price,
              markPrice: Number(info.markPrice) > 0 ? Number(info.markPrice) : undefined,
              notional: Number(info.notional) > 0 ? Number(info.notional) : undefined,
              initialMargin: Number(info.initialMargin) > 0 ? Number(info.initialMargin) : undefined,
              unrealizedPnl: Number.isFinite(Number(info.unrealizedPnl)) ? Number(info.unrealizedPnl) : undefined,
              initialAmount: previousHolding?.initialAmount || amount,
              stopPrice: previousHolding?.stopPrice,
              tp1Price: previousHolding?.tp1Price,
              tp2Price: previousHolding?.tp2Price,
              trailingStopPrice: previousHolding?.trailingStopPrice,
              trailingBufferPct: previousHolding?.trailingBufferPct,
              highestPrice: previousHolding?.highestPrice,
              lowestPrice: previousHolding?.lowestPrice,
              time: new Date().toISOString()
            };
          }).filter((h): h is Holding => h !== null);

          setHoldings(freshHoldings);
          console.log(`[TradeEdge SYNC] Frontend holdings updated: ${freshHoldings.length} positions ready for Active Positions Engine`);
          if (freshHoldings.length > 0) {
            console.log(`[TradeEdge SYNC] Holdings: ${freshHoldings.map(h => `${h.symbol}(${h.side})`).join(', ')}`);
          }
        }

        const totalPositionsValue = freshHoldings.reduce((sum, h) => {
           const price = marketPicks.find(p => p.symbol === h.symbol)?.lastPrice || holdingPrices[h.symbol] || h.entryPrice;
           return sum + (price * h.amount);
        }, 0);

        // For Binance Portfolio Margin, backend `equity` already includes wallet/position value.
        // Fallback to cash + positions only when equity is unavailable.
        const currentEquity = Number.isFinite(liveEquity) && liveEquity > 0
          ? liveEquity
          : (usdt + totalPositionsValue);

        // Auto-initialize baseline if placeholder or first sync in real mode
        const defaults = [0, 600, 800, 1000];
        if (currentEquity > 0 && (defaults.includes(benchmarkCapital) || (!isRealMode && !holdings.length))) {
          setBenchmarkCapital(currentEquity);
          addLog(`BASIS LOCKED: Tracking performance from $${currentEquity.toFixed(2)} baseline.`, 'info');
        }

        // GHOST BASIS RESET: If baseline is huge but equity is 0/small on first real sync, auto-correct
        if (isRealMode && benchmarkCapital > 2000 && currentEquity < 100 && usdt === 0) {
           addLog(`GHOST BASIS REJECTED: Resetting anomalous $${benchmarkCapital.toFixed(2)} baseline to reality.`, 'warning');
           setBenchmarkCapital(currentEquity);
        }
        
        reportSyncError(null);
        addLog(`SYNC SUCCESS: [${data.account || 'Margin'}] Total Equity $${currentEquity.toFixed(2)} (Cash: $${usdt.toFixed(2)})`, 'success');
        setServerStatus('OK');
        return true;
      } else {
        setAuthDegradedMessage(null);
        const message = data.message || 'Unknown balance sync error';
        reportSyncError(message);
        setExecutionFeedback({ type: 'warning', message });
        addLog(`SYNC FAILED: ${message}`, 'warning');
        return false;
      }
    } catch (e: any) {
      console.error('Sync Error:', e);
      setAuthDegradedMessage(null);
      addLog(`SYNC ERROR: ${e.message}`, 'warning');
      reportSyncError(e.message);
      setServerStatus('ERROR');
      return false;
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [addLog, reportSyncError, serverConfig?.outboundIp, benchmarkCapital, holdings.length, isRealMode, marketPicks, holdingPrices]);

  React.useEffect(() => {
    syncRealBalanceRef.current = syncRealBalance;
  }, [syncRealBalance]);

  const checkServer = React.useCallback(async () => {
    try {
      const resp = await fetch('/api/health');
      if (resp.ok) {
        const data = await resp.json();
        if (Number(data?.blockedUntil) > Date.now()) {
          setRateLimitUntil(Number(data.blockedUntil));
        }
        setServerStatus('OK');
        setServerConfig({
          ...data.config,
          outboundIp: data.outboundIp,
          exchange: data.exchange,
          type: data.type,
          binanceRouteHealth: data.binanceRouteHealth,
        });
      }
      else setServerStatus('ERROR');
    } catch {
      setServerStatus('ERROR');
    }
  }, []);

  const executeTrade = React.useCallback(async (type: 'BUY' | 'SELL', tradeSymbol: string, price: number, reason: string = 'Strategy Match', targetId?: string, cycleId?: number, tradePlan?: StrategySignal['tradePlan'], requestedAmount?: number) => {
    if (loading || !price) return;
    const time = new Date().toISOString();
    const eventCycleId = typeof cycleId === 'number' ? cycleId : undefined;
    const normalizedTradeSymbol = String(tradeSymbol || '').toUpperCase();
    const hasAllowedLiveQuote = liveQuoteAllowlist.some((quote: string) => normalizedTradeSymbol.endsWith(quote));
    
    if (tradeSymbol.includes('undefined') || price <= 0) {
       addLog(`TRADE ABORTED: Invalid symbol or price [${tradeSymbol} @ ${price}]`, 'warning');
      setExecutionFeedback({ type: 'warning', message: `${type} blocked: invalid symbol/price (${tradeSymbol}).` });
      pushTradeEvent({ type, symbol: tradeSymbol || 'UNKNOWN', price: price || 0, amount: 0, time: new Date().toISOString(), reason: 'SKIP: Invalid symbol/price', status: 'SKIPPED', cycleId: eventCycleId });
       return;
    }

    const isHeld = targetId 
      ? holdings.some(h => h.id === targetId)
      : holdings.some(h => h.symbol === tradeSymbol);
    const isRealShortEntry = isRealMode && type === 'SELL' && !targetId && !isHeld;
    const requiresLiveFuturesValidation = isRealMode;
    if (type === 'SELL' && !isHeld && !isRealShortEntry) {
      setExecutionFeedback({ type: 'warning', message: `SELL skipped for ${tradeSymbol}: no open position to close.` });
      pushTradeEvent({ type, symbol: tradeSymbol, price, amount: 0, time: new Date().toISOString(), reason: 'SKIP: No open position to close', status: 'SKIPPED', cycleId: eventCycleId });
      return;
    }

    if (requiresLiveFuturesValidation && (type === 'BUY' || isRealShortEntry)) {
      let tradableSymbols = liveTradableSymbolsRef.current;
      const normalizedTradeSymbolKey = normalizeLiveFuturesSymbol(tradeSymbol);
      const shouldRefreshTradableSymbols = tradableSymbols.size === 0 || !tradableSymbols.has(normalizedTradeSymbolKey);
      if (shouldRefreshTradableSymbols) {
        try {
          const refreshedSymbols = await fetchAllSymbols({
            includeSpot: false,
            includeFutures: true,
            fullUniverse: true,
            allowedQuotes: liveQuoteAllowlist,
            forceBinancePublic: true,
          });
          const refreshedTradableSymbols = new Set(refreshedSymbols.map(s => normalizeLiveFuturesSymbol(s.value)));
          if (refreshedTradableSymbols.size > 0) {
            liveTradableSymbolsRef.current = refreshedTradableSymbols;
            liveTradableSymbolsFetchedAtRef.current = Date.now();
            tradableSymbols = refreshedTradableSymbols;
          }
        } catch (refreshError) {
          console.warn('[TradeEdge] Failed to refresh Binance futures tradable symbol cache before order submit', refreshError);
        }
      }
      if (tradableSymbols.size === 0) {
        addLog('TRADE SKIPPED: Binance futures tradable symbol cache unavailable. Blocking new live entry for safety.', 'warning');
        setExecutionFeedback({ type: 'warning', message: `${type} blocked: futures tradable symbol cache unavailable.` });
        pushTradeEvent({ type, symbol: tradeSymbol, price, amount: 0, time, reason: 'SKIP: Futures tradable symbol cache unavailable', status: 'SKIPPED', cycleId: eventCycleId });
        return;
      }
      if (!tradableSymbols.has(normalizedTradeSymbolKey)) {
        addLog(`TRADE SKIPPED: ${tradeSymbol} is not present in Binance futures tradable symbols.`, 'warning');
        setExecutionFeedback({ type: 'warning', message: `${type} blocked: ${tradeSymbol} is not tradable on Binance futures.` });
        pushTradeEvent({ type, symbol: tradeSymbol, price, amount: 0, time, reason: 'SKIP: Not in Binance futures tradable symbols', status: 'SKIPPED', cycleId: eventCycleId });
        blockUnsupportedScanSymbol(tradeSymbol);
        return;
      }
    }

    // Reject malformed symbols and quote-asset crosses like USDCUSDT.
    if (isNonTradableQuoteBaseSymbol(tradeSymbol)) {
      addLog(`TRADE ABORTED: ${tradeSymbol} is not a tradable futures position. USDT remains cash available for trading.`, 'warning');
      setExecutionFeedback({ type: 'warning', message: `${type} blocked: invalid symbol "${tradeSymbol}".` });
      pushTradeEvent({ type, symbol: tradeSymbol, price, amount: 0, time: new Date().toISOString(), reason: 'SKIP: Malformed symbol', status: 'SKIPPED', cycleId: eventCycleId });
      return;
    }

    if (isRealMode && !hasAllowedLiveQuote) {
      addLog(`TRADE SKIPPED: ${tradeSymbol} does not match allowed live quotes [${liveQuoteAllowlist.join(', ')}].`, 'warning');
      setExecutionFeedback({ type: 'warning', message: `${type} blocked: ${tradeSymbol} is outside allowed live quotes.` });
      pushTradeEvent({ type, symbol: tradeSymbol, price, amount: 0, time, reason: 'SKIP: Outside allowed live quotes', status: 'SKIPPED', cycleId: eventCycleId });
      return;
    }

    const lockKey = `${type}_${tradeSymbol}_${targetId || 'all'}`;
    if (tradeLockout.current.has(lockKey)) {
      setExecutionFeedback({ type: 'warning', message: `${type} skipped for ${tradeSymbol}: duplicate order lockout.` });
      pushTradeEvent({ type, symbol: tradeSymbol, price, amount: 0, time: new Date().toISOString(), reason: 'SKIP: Duplicate order lockout', status: 'SKIPPED', cycleId: eventCycleId });
      return;
    }
    tradeLockout.current.add(lockKey);
    setTimeout(() => tradeLockout.current.delete(lockKey), duplicateOrderLockoutSec * 1000);


    if (isRealMode) {
      setExecutionFeedback({ type: 'info', message: `Submitting ${type} ${tradeSymbol} at $${formatPrice(price)}...` });
      addLog(`EXECUTING REAL ${type}: ${tradeSymbol} @ $${price} [${reason}]`, 'info');
      let existingHolding = holdings.find(h => targetId ? h.id === targetId : h.symbol === tradeSymbol);
      let heldAmount = existingHolding?.amount || 0;
      let heldSide = existingHolding?.side;
      let openingShort = type === 'SELL' && (!existingHolding || heldAmount <= 0);
      let closingExisting = Boolean(existingHolding) && (
        (heldSide === 'LONG' && type === 'SELL') ||
        (heldSide === 'SHORT' && type === 'BUY')
      );

      const entryLockActive = entryLockUntilRef.current > Date.now();
      if ((type === 'BUY' || openingShort) && !closingExisting && entryLockActive) {
        const remainingSec = Math.max(1, Math.ceil((entryLockUntilRef.current - Date.now()) / 1000));
        const lockMsg = `ENTRY LOCK ACTIVE (${remainingSec}s): waiting for successful exits before new positions.`;
        addLog(lockMsg, 'warning');
        setExecutionFeedback({ type: 'warning', message: lockMsg });
        pushTradeEvent({ type, symbol: tradeSymbol, price, amount: 0, time, reason: `SKIP: ${lockMsg}`, status: 'SKIPPED', cycleId: eventCycleId });
        return;
      }

      const lockEntries = (ms: number, why: string) => {
        const until = Date.now() + ms;
        setEntryLockUntil(prev => Math.max(prev, until));
        addLog(`ENTRY LOCK: ${why}`, 'warning');
      };

      const clearEntryLock = () => {
        if (entryLockUntilRef.current > Date.now()) {
          setEntryLockUntil(0);
        }
      };

      const applyOptimisticLiveFill = (
        fillType: 'BUY' | 'SELL',
        fillSymbol: string,
        fillAmount: number,
        fillPrice: number,
        fillTime: string,
      ) => {
        setHoldings(prev => {
          const normalizedSymbol = String(fillSymbol || '').toUpperCase();
          const current = [...prev];

          const openSide: 'LONG' | 'SHORT' = fillType === 'BUY' ? 'LONG' : 'SHORT';

          if (closingExisting) {
            if (targetId) {
              return current.flatMap(h => {
                if (h.id !== targetId) return [h];
                const remainingAmount = Math.max(0, Number(h.amount || 0) - Number(fillAmount || 0));
                if (remainingAmount <= 1e-12) return [];
                return [{
                  ...h,
                  amount: remainingAmount,
                  contracts: remainingAmount,
                }];
              });
            }
            return current.filter(h => h.symbol !== normalizedSymbol);
          }

          const existingIdx = current.findIndex(h => h.symbol === normalizedSymbol && h.side === openSide);
          if (existingIdx >= 0) {
            const existing = current[existingIdx];
            const nextAmount = Math.max(0, Number(existing.amount || 0) + Number(fillAmount || 0));
            const weightedEntry = nextAmount > 0
              ? (((existing.entryPrice || fillPrice) * (existing.amount || 0)) + (fillPrice * fillAmount)) / nextAmount
              : fillPrice;
            current[existingIdx] = {
              ...existing,
              amount: nextAmount,
              contracts: nextAmount,
              entryPrice: Number.isFinite(weightedEntry) && weightedEntry > 0 ? weightedEntry : fillPrice,
              initialAmount: Math.max(existing.initialAmount || existing.amount || 0, nextAmount),
              time: fillTime,
            };
            return current;
          }

          const holdingId = `${normalizedSymbol}_${openSide}_${Date.now()}`;
          return [
            ...current,
            {
              id: holdingId,
              symbol: normalizedSymbol,
              amount: Math.max(0, Number(fillAmount || 0)),
              contracts: Math.max(0, Number(fillAmount || 0)),
              side: openSide,
              entryPrice: fillPrice,
              initialAmount: Math.max(0, Number(fillAmount || 0)),
              stopPrice: tradePlan?.stopPrice,
              tp1Price: tradePlan?.tp1Price,
              tp2Price: tradePlan?.tp2Price,
              trailingStopPrice: tradePlan?.stopPrice,
              trailingBufferPct: tradePlan?.trailingBufferPct,
              highestPrice: openSide === 'LONG' ? fillPrice : undefined,
              lowestPrice: openSide === 'SHORT' ? fillPrice : undefined,
              time: fillTime,
            }
          ];
        });
      };

      const normalizeLiveSymbol = (rawSymbol: string) => {
        const compact = String(rawSymbol || '')
          .toUpperCase()
          .replace('/', '')
          .replace(':USDT', '')
          .replace(':USD', '')
          .replace(':', '');
        if (!compact) return compact;
        if (compact.endsWith('USDT') || compact.endsWith('USD')) return compact;
        if (compact.endsWith('USD') && !compact.endsWith('USDT')) return `${compact}T`;
        return `${compact}USDT`;
      };

      const hasPositionForSymbol = (positions: Record<string, any>, rawSymbol: string) => {
        const normalized = normalizeLiveSymbol(rawSymbol);
        if (!normalized) return false;
        const alt = normalized.endsWith('USDT') ? normalized.slice(0, -1) : `${normalized}T`;
        const candidates = [normalized, alt];
        return candidates.some((key) => {
          const p = positions?.[key];
          const amt = Number(p?.amount ?? p?.total ?? 0);
          return Number.isFinite(amt) && Math.abs(amt) > 0;
        });
      };

      let amount = 0;

      try {
        existingHolding = holdings.find(h => targetId ? h.id === targetId : h.symbol === tradeSymbol);
        heldAmount = existingHolding?.amount || 0;
        heldSide = existingHolding?.side;
        openingShort = type === 'SELL' && (!existingHolding || heldAmount <= 0);
        closingExisting = Boolean(existingHolding) && (
          (heldSide === 'LONG' && type === 'SELL') ||
          (heldSide === 'SHORT' && type === 'BUY')
        );

        if (closingExisting) {
          amount = Math.min(heldAmount, requestedAmount && requestedAmount > 0 ? requestedAmount : heldAmount);
        } else if (type === 'BUY' || openingShort) {
          const effectiveSplitSlots = 1;
          const realFreeCapital = Math.max(0, availableFunds * 0.99);
          const tradableCapital = isRealMode
            ? realFreeCapital
            : Math.max(0, balance);
          let allocation = Math.min(tradableCapital, tradableCapital / effectiveSplitSlots);
          const minLiveNotional = liveMinOrderNotional;

          // Avoid over-fragmenting capital across many slots; if we can fund at least one
          // minimal order, keep per-trade allocation at $10+ instead of skipping every entry.
          if (tradableCapital >= minLiveNotional) {
            allocation = Math.max(allocation, minLiveNotional);
          }

          allocation = Math.min(allocation, tradableCapital);

          if (allocation < minLiveNotional) {
            addLog(`TRADE ABORTED: Available allocation ($${allocation.toFixed(2)}) below minimum threshold ($${minLiveNotional.toFixed(2)}).`, 'warning');
            pushTradeEvent({ type, symbol: tradeSymbol, price, amount: 0, time, reason: `SKIP: Allocation below $${minLiveNotional.toFixed(2)} minimum`, status: 'SKIPPED', cycleId: eventCycleId });
            return;
          }

          if (isDefensiveMode) {
            allocation *= 0.5;
            addLog(`ADAPTIVE DEFENSE: Reducing trade allocation by 50% for ${tradeSymbol}`, 'info');
          }

          amount = allocation / price;
        } else {
          amount = heldAmount;
        }

        if (amount <= 0) {
          addLog(`TRADE ABORTED: Unable to size order for ${tradeSymbol}.`, 'warning');
          pushTradeEvent({ type, symbol: tradeSymbol, price, amount: 0, time, reason: 'SKIP: Unable to size order', status: 'SKIPPED', cycleId: eventCycleId });
          return;
        }

        const requestedPositionSide: 'LONG' | 'SHORT' = closingExisting
          ? (heldSide === 'SHORT' ? 'SHORT' : 'LONG')
          : (openingShort ? 'SHORT' : 'LONG');
        const reduceOnly = closingExisting;

        const submitOrderOnce = async () => {
          const resp = await fetch('/api/binance/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol: tradeSymbol,
              side: type,
              type: 'MARKET',
              amount: amount > 0 ? amount : undefined,
              positionSide: requestedPositionSide,
              reduceOnly,
            })
          });
          return await resp.json();
        };

        let result: any = null;
        const submitAttempts = closingExisting ? 3 : 1;
        for (let attempt = 1; attempt <= submitAttempts; attempt++) {
          result = await submitOrderOnce();
          if (result?.status === 'success') break;
          if (attempt < submitAttempts) {
            await new Promise(r => setTimeout(r, 500));
            addLog(`EXIT RETRY ${attempt}/${submitAttempts - 1}: ${tradeSymbol}`, 'warning');
          }
        }

        if (result.status === 'success') {

          // Verify position state after order acknowledgement. Some accounts cannot
          // read positionRisk immediately (or at all), so we treat accepted orders
          // as pending confirmation instead of hard-failing immediately.
          let verified = false;
          let verifyAttempts = 0;
          let authDegradedDuringVerify = false;
          try {
            while (verifyAttempts < 4 && !verified) {
              await new Promise(r => setTimeout(r, 600 + verifyAttempts * 400));
              const verifyResp = await fetch('/api/binance/balance');
              if (verifyResp.ok) {
                const verify = await verifyResp.json();
                // If position-risk endpoint is degraded (-2015), skip verification and mark as filled immediately.
                if (verify?.authDegraded === true) {
                  authDegradedDuringVerify = true;
                  verified = true;
                  console.log(`[TradeEdge] AUTH DEGRADED during verification - auto-confirming order ${result?.order?.id}`);
                  break;
                }
                const positions = verify?.positions || {};
                const hasPosition = hasPositionForSymbol(positions, tradeSymbol);
                if (closingExisting) {
                  verified = !hasPosition;
                } else if (type === 'BUY' || openingShort) {
                  verified = hasPosition;
                }
                if (verified) {
                  console.log(`[TradeEdge] VERIFIED: ${type} ${tradeSymbol} - Position confirmed after attempt ${verifyAttempts + 1}`);
                  break;
                }
              }
              verifyAttempts++;
            }
          } catch (e) {
            console.warn(`[TradeEdge] Verification fetch failed: ${e}`);
          }

          if (!verified) {
            const orderId = result?.order?.id || result?.order?.clientOrderId || result?.order?.info?.orderId;
            const msg = `Order accepted by exchange but live position not yet visible${orderId ? ` (order ${orderId})` : ''}.`;
            addLog(`REAL ${type} UNCONFIRMED: ${tradeSymbol} - ${msg}`, 'warning');
            if (!closingExisting) {
              applyOptimisticLiveFill(type, tradeSymbol, amount, price, time);
              setExecutionFeedback({ type: 'info', message: `${type} submitted for ${tradeSymbol}. Awaiting exchange confirmation.` });
              pushTradeEvent({ type, symbol: tradeSymbol, price, amount, time, reason: `SUBMITTED: ${msg}`, status: 'SUBMITTED', cycleId: eventCycleId });
              setCooldowns(prev => ({ ...prev, [tradeSymbol]: Date.now() + (1000 * 60 * successCooldownMinutes) }));
              setTimeout(syncRealBalance, 1500);
              setTimeout(syncRealBalance, 4500);
              return;
            }

            setExecutionFeedback({ type: 'warning', message: `${type} unconfirmed for ${tradeSymbol}. Will retry on next cycle.` });
            pushTradeEvent({ type, symbol: tradeSymbol, price, amount, time, reason: `UNCONFIRMED: ${msg}`, status: 'FAILED', cycleId: eventCycleId });
            if (closingExisting) {
              lockEntries(closeFailureLockMinutes * 60 * 1000, `Close verification failed for ${tradeSymbol}. New entries paused for ${closeFailureLockMinutes}m.`);
            }
            setCooldowns(prev => ({ ...prev, [tradeSymbol]: Date.now() + (1000 * 60 * softCooldownMinutes) }));
            setTimeout(syncRealBalance, 1500);
            setTimeout(syncRealBalance, 4500);
            return;
          }

          if (authDegradedDuringVerify) {
            const orderId = result?.order?.id || result?.order?.clientOrderId || result?.order?.info?.orderId;
            applyOptimisticLiveFill(type, tradeSymbol, amount, price, time);
            addLog(`REAL ${type} SUCCESS: ${tradeSymbol} [Verified by order response; position-risk endpoint unavailable]`, 'success');
            setExecutionFeedback({ type: 'success', message: `${type} confirmed on exchange for ${tradeSymbol}.` });
            pushTradeEvent({
              type,
              symbol: tradeSymbol,
              price,
              amount,
              time,
              reason: `ORDER CONFIRMED: ${orderId}`,
              status: 'FILLED',
              cycleId: eventCycleId,
            });
            setCooldowns(prev => ({ ...prev, [tradeSymbol]: Date.now() + (1000 * 60 * successCooldownMinutes) }));
            setTimeout(syncRealBalance, 2000);
            return;
          }

          if (closingExisting) {
            clearEntryLock();
          }

          const closingLong = heldSide === 'LONG' && type === 'SELL';
          const closingShort = heldSide === 'SHORT' && type === 'BUY';
          if (closingLong || closingShort) {
            const realized = closingLong
              ? (price - (existingHolding?.entryPrice || price)) * amount
              : ((existingHolding?.entryPrice || price) - price) * amount;
            const basis = (existingHolding?.entryPrice || price) * Math.max(amount, 1e-12);
            const realizedPct = basis > 0 ? (realized / basis) * 100 : 0;
            applyOptimisticLiveFill(type, tradeSymbol, amount, price, time);
            pushTradeEvent({
              type,
              symbol: tradeSymbol,
              price,
              entryPrice: existingHolding?.entryPrice,
              amount,
              time,
              reason,
              pnl: realized,
              pnlPct: realizedPct,
              status: 'FILLED',
              cycleId: eventCycleId,
            });
          } else {
            applyOptimisticLiveFill(type, tradeSymbol, amount, price, time);
            pushTradeEvent({
              type,
              symbol: tradeSymbol,
              price,
              amount,
              time,
              reason,
              status: 'FILLED',
              cycleId: eventCycleId,
            });
          }

          addLog(`REAL ${type} SUCCESS: ${tradeSymbol}`, 'success');
          setExecutionFeedback({ type: 'success', message: `${type} confirmed on exchange for ${tradeSymbol}.` });
          setCooldowns(prev => ({ ...prev, [tradeSymbol]: Date.now() + (1000 * 60 * successCooldownMinutes) }));
          setTimeout(syncRealBalance, 1500); 
        } else {
          throw new Error(result.message || 'Order failed');
        }
      } catch (e: any) {
        const msg = String(e?.message || 'Unknown order failure');
        const isMarginOrFundsFailure = /-2019|margin is insufficient|insufficient margin|insufficient balance/i.test(msg);
        const isAuthFailure = /-2015|invalid api-key|invalid api key|ip|permissions for action|whitelist/i.test(msg);
        const unsupportedMarketFailure = /(SYMBOL SKIPPED|UNSUPPORTED MARKET|does not have market symbol)/i.test(msg);
        const softSkip = /(SYMBOL SKIPPED|UNSUPPORTED MARKET|does not have market symbol|INVALID ORDER SIZE|ORDER SIZE UNDERFLOW|allocation below|Unable to size|No open position|Duplicate order lockout)/i.test(msg);

        if (softSkip) {
          if (unsupportedMarketFailure) {
            blockUnsupportedScanSymbol(tradeSymbol);
          }
          addLog(`REAL ${type} SKIPPED: ${msg}`, 'warning');
          setExecutionFeedback({ type: 'warning', message: `${type} skipped for ${tradeSymbol}: ${msg}` });
          pushTradeEvent({ type, symbol: tradeSymbol, price, amount: 0, time, reason: `SKIP: ${msg}`, status: 'SKIPPED', cycleId: eventCycleId });
          setCooldowns(prev => ({ ...prev, [tradeSymbol]: Date.now() + (1000 * 60 * softCooldownMinutes) }));
          return;
        }

        // Some exchange/network errors can occur after order placement.
        // Re-sync once and verify position state before marking FAILED.
        let verified = false;
        try {
          const verifyResp = await fetch('/api/binance/balance');
          if (verifyResp.ok) {
            const verify = await verifyResp.json();
            const positions = verify?.positions || {};
            const hasPosition = hasPositionForSymbol(positions, tradeSymbol);
            if (closingExisting) {
              verified = !hasPosition;
            } else if (type === 'BUY' || openingShort) {
              verified = hasPosition;
            }
          }
        } catch {
          // Keep original failure classification below.
        }

        if (verified) {
          addLog(`REAL ${type} VERIFIED: ${tradeSymbol} (post-error exchange state confirms fill)`, 'success');
          setExecutionFeedback({ type: 'success', message: `${type} verified for ${tradeSymbol} after exchange resync.` });
          if (closingExisting) {
            clearEntryLock();
          }
          pushTradeEvent({
            type,
            symbol: tradeSymbol,
            price,
            amount: heldAmount || 0,
            time,
            reason: `VERIFIED AFTER ERROR: ${msg}`,
            status: 'FILLED',
            cycleId: eventCycleId,
          });
          setTimeout(syncRealBalance, 1500);
          return;
        }

        if (!isMarginOrFundsFailure && !isAuthFailure) {
          const pendingMsg = `Order submission for ${tradeSymbol} needs delayed confirmation (${msg}).`;
          addLog(`REAL ${type} UNCONFIRMED: ${pendingMsg}`, 'warning');
          if (!closingExisting && (type === 'BUY' || openingShort)) {
            const optimisticAmount = amount > 0 ? amount : heldAmount || 0;
            if (optimisticAmount > 0) {
              applyOptimisticLiveFill(type, tradeSymbol, optimisticAmount, price, time);
            }
            setExecutionFeedback({ type: 'info', message: `${type} submitted for ${tradeSymbol}. Waiting for exchange confirmation.` });
            pushTradeEvent({ type, symbol: tradeSymbol, price, amount: optimisticAmount, time, reason: `SUBMITTED: ${msg}`, status: 'SUBMITTED', cycleId: eventCycleId });
            setCooldowns(prev => ({ ...prev, [tradeSymbol]: Date.now() + (1000 * 60 * successCooldownMinutes) }));
            setTimeout(syncRealBalance, 1500);
            setTimeout(syncRealBalance, 4500);
            return;
          }

          setExecutionFeedback({ type: 'warning', message: `${type} unconfirmed for ${tradeSymbol}. Waiting for exchange confirmation.` });
          pushTradeEvent({ type, symbol: tradeSymbol, price, amount: heldAmount || 0, time, reason: `UNCONFIRMED: ${msg}`, status: 'FAILED', cycleId: eventCycleId });
          setTimeout(syncRealBalance, 1500);
          setTimeout(syncRealBalance, 4500);
          return;
        }

        addLog(`REAL ${type} FAILED: ${msg}`, 'warning');
  setExecutionFeedback({ type: 'warning', message: `${type} failed for ${tradeSymbol}: ${msg}` });
        pushTradeEvent({ type, symbol: tradeSymbol, price, amount: 0, time, reason: `FAILED: ${msg}`, status: 'FAILED', cycleId: eventCycleId });

        if (isMarginOrFundsFailure || isAuthFailure) {
          // Hard fail-safe: disable autonomous trading immediately on exchange-level hard failures.
          autoTradeRef.current = false;
          setAutoTrade(false);
          lockEntries(hardFailureLockMinutes * 60 * 1000, `Entry lock engaged after hard exchange failure (${isAuthFailure ? 'auth/permission' : 'margin'}).`);
          if (isAuthFailure) {
            setIsRealMode(false);
            addLog('LIVE MODE DISABLED: Exchange auth/permission failure detected.', 'warning');
          } else {
            addLog('AUTONOMOUS PAUSED: Margin insufficient. Review leverage/available margin before retrying.', 'warning');
          }
        }

        if (closingExisting) {
          lockEntries(closeFailureLockMinutes * 60 * 1000, `Close order failed for ${tradeSymbol}. New entries paused for ${closeFailureLockMinutes}m.`);
        }
        setCooldowns(prev => ({ ...prev, [tradeSymbol]: Date.now() + (1000 * 60 * softCooldownMinutes) }));
        return;
      }
    } else {
      const existingHolding = holdings.find(h => targetId ? h.id === targetId : h.symbol === tradeSymbol);
      const heldSide = existingHolding?.side;
      const closingExisting = Boolean(existingHolding) && (
        (heldSide === 'LONG' && type === 'SELL') ||
        (heldSide === 'SHORT' && type === 'BUY')
      );
      const openingShort = type === 'SELL' && !closingExisting;
      const openingEntry = (type === 'BUY' && !closingExisting) || openingShort;

      if (openingEntry) {
        if (holdings.length >= maxConcurrentTrades) {
          addLog(`${type} SKIPPED: Max concurrent trades (${maxConcurrentTrades}) reached.`, 'warning');
          pushTradeEvent({ type, symbol: tradeSymbol, price, amount: 0, time, reason: `SKIP: Max concurrent trades (${maxConcurrentTrades}) reached`, status: 'SKIPPED', cycleId: eventCycleId });
          return;
        }

        const slotsAvailable = Math.max(1, maxConcurrentTrades - holdings.length);
        const currentBalance = Math.max(0, balance);
        let allocation = Math.min(currentBalance / slotsAvailable, currentBalance);
        
        if (allocation < minPaperAllocation) {
          addLog(`PAPER TRADE SKIPPED: Insufficient balance for minimum $${minPaperAllocation.toFixed(2)} allocation.`, 'warning');
          pushTradeEvent({ type, symbol: tradeSymbol, price, amount: 0, time, reason: `SKIP: Insufficient balance for $${minPaperAllocation.toFixed(2)} minimum`, status: 'SKIPPED', cycleId: eventCycleId });
          return;
        }

        const amount = allocation / price;
        const holdingId = Math.random().toString(36).substring(2, 15);
        
        let commission = 0.001;
        if (allocation > 500) commission = 0.0008; 
        if (serverConfig?.exchange === 'gemini') commission = 0.004; 
        if (useBNBFees && serverConfig?.exchange !== 'gemini') commission *= 0.75; 

        setBalance(prev => prev - allocation);
        setHoldings(prev => [...prev, {
          id: holdingId,
          symbol: tradeSymbol,
          amount,
          initialAmount: amount,
          side: openingShort ? 'SHORT' : 'LONG',
          entryPrice: price,
          stopPrice: tradePlan?.stopPrice,
          tp1Price: tradePlan?.tp1Price,
          tp2Price: tradePlan?.tp2Price,
          trailingStopPrice: tradePlan?.stopPrice,
          trailingBufferPct: tradePlan?.trailingBufferPct,
          highestPrice: openingShort ? undefined : price,
          lowestPrice: openingShort ? price : undefined,
          time,
        }]);
        pushTradeEvent({ type, symbol: tradeSymbol, price, amount, time, reason, status: 'FILLED', cycleId: eventCycleId });
        addLog(`PAPER ${openingShort ? 'SHORT' : 'BUY'}: ${tradeSymbol} @ $${price} [${reason}]`, 'success');
        setExecutionFeedback({ type: 'success', message: `Paper ${openingShort ? 'SHORT' : 'BUY'} filled for ${tradeSymbol}.` });
      } else {
        // If targetId is provided, close ONLY that one. Otherwise close ALL for this symbol.
        const holdingsToClose = targetId 
          ? holdings.filter(h => h.id === targetId)
          : holdings.filter(h => h.symbol === tradeSymbol);

        if (holdingsToClose.length > 0) {
          const partialRequested = Boolean(targetId && requestedAmount && requestedAmount > 0 && holdingsToClose.length === 1);
          let totalReleaseValue = 0;
          let totalEntryValue = 0;
          let totalAmount = 0;
          let totalPnl = 0;

          holdingsToClose.forEach(h => {
             const closingAmount = partialRequested ? Math.min(h.amount, requestedAmount || h.amount) : h.amount;
             const exitValue = closingAmount * price;
             const entryValue = closingAmount * h.entryPrice;
             
             const commissionRate = serverConfig?.exchange === 'gemini' ? 0.004 : 0.001;
             const exitCommission = exitValue * commissionRate;
             const pnlForHolding = h.side === 'SHORT'
               ? (entryValue - exitValue - exitCommission)
               : (exitValue - exitCommission - entryValue);
             const releasedCapital = entryValue + pnlForHolding;

             totalReleaseValue += releasedCapital;
             totalEntryValue += entryValue;
             totalAmount += closingAmount;
             totalPnl += pnlForHolding;
          });

          const pnl = totalPnl;
          const pnlPct = totalEntryValue > 0 ? (pnl / totalEntryValue) * 100 : 0;

          setBalance(prev => prev + totalReleaseValue);
          
          if (targetId) {
            setHoldings(prev => prev.flatMap(h => {
              if (h.id !== targetId) return [h];
              const remainingAmount = partialRequested ? Math.max(0, h.amount - (requestedAmount || h.amount)) : 0;
              if (remainingAmount <= 1e-12) return [];
              return [{ ...h, amount: remainingAmount, contracts: remainingAmount }];
            }));
          } else {
            setHoldings(prev => prev.filter(h => h.symbol !== tradeSymbol));
          }

          if (pnlPct < 0) {
             setCooldowns(prev => ({ ...prev, [tradeSymbol]: Date.now() + (1000 * 60 * paperLossCooldownMinutes) }));
             addLog(`TRADE EXIT [${tradeSymbol}]: Loss of $${Math.abs(pnl).toFixed(2)} (${pnlPct.toFixed(2)}%)`, 'warning');
          } else {
             addLog(`TRADE EXIT [${tradeSymbol}]: Profit of $${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`, 'success');
          }

          pushTradeEvent({ 
            type, 
            symbol: tradeSymbol, 
            price, 
            entryPrice: totalEntryValue / totalAmount, 
            amount: totalAmount, 
            time, 
            reason, 
            pnl, 
            pnlPct,
            status: 'FILLED',
            cycleId: eventCycleId,
          });
          
          addLog(`PAPER SELL: ${tradeSymbol} @ $${price} | P&L: ${pnlPct.toFixed(2)}% [${reason}]`, pnl >= 0 ? 'success' : 'warning');
          setExecutionFeedback({ type: 'success', message: `Paper SELL filled for ${tradeSymbol}.` });
        }
      }
    }
  }, [symbol, holdings, maxConcurrentTrades, useBNBFees, isRealMode, balance, syncRealBalance, addLog, isDefensiveMode, serverConfig?.exchange, loading, pushTradeEvent, duplicateOrderLockoutSec, liveMinOrderNotional, closeFailureLockMinutes, softCooldownMinutes, successCooldownMinutes, minPaperAllocation, paperLossCooldownMinutes, hardFailureLockMinutes]);

  const managePlannedExit = React.useCallback((holding: Holding, price: number, signal?: StrategySignal | null, cycleId?: number) => {
    const closeSide: 'BUY' | 'SELL' = holding.side === 'SHORT' ? 'BUY' : 'SELL';
    const fallbackStop = holding.side === 'SHORT'
      ? holding.entryPrice * (1 + stopLossPercent / 100)
      : holding.entryPrice * (1 - stopLossPercent / 100);
    const stopPrice = holding.stopPrice || fallbackStop;
    const riskPerUnit = Math.max(Math.abs(holding.entryPrice - stopPrice), holding.entryPrice * 0.005);
    const tp1Price = holding.tp1Price || (holding.side === 'SHORT' ? holding.entryPrice - (riskPerUnit * 1.25) : holding.entryPrice + (riskPerUnit * 1.25));
    const tp2Price = holding.tp2Price || (holding.side === 'SHORT' ? holding.entryPrice - (riskPerUnit * 2.4) : holding.entryPrice + (riskPerUnit * 2.4));
    const trailingBufferPct = holding.trailingBufferPct || 0.012;
    const initialAmount = Math.max(holding.initialAmount || holding.amount, holding.amount);
    const runnerAmount = Math.max(initialAmount * 0.2, 0);
    const tp1Completed = holding.amount <= (initialAmount * 0.55);
    const runnerStage = holding.amount <= (runnerAmount * 1.05);
    const contracts = Number(holding.contracts || holding.amount || 0);
    const notional = Number(holding.notional || (contracts * holding.entryPrice) || 0);
    const margin = Number(holding.initialMargin || (notional > 0 ? notional / 5 : 0) || 0);
    const currentUnrealizedPnl = (holding.side === 'SHORT'
      ? (holding.entryPrice - price)
      : (price - holding.entryPrice)) * contracts;
    const currentMarginPnlPct = margin > 0 ? (currentUnrealizedPnl / margin) * 100 : 0;
    const histogramExpanding = holding.side === 'LONG'
      ? signal?.confluence.macdHistogram === 'BULLISH_ACCELERATION'
      : signal?.confluence.macdHistogram === 'BEARISH_ACCELERATION';
    const momentumWeakening = holding.side === 'LONG'
      ? signal?.exitSignal === 'EXIT_LONG' || signal?.confluence.macdHistogram === 'BULLISH_FADE' || signal?.confluence.macd === 'BEARISH'
      : signal?.exitSignal === 'EXIT_SHORT' || signal?.confluence.macdHistogram === 'BEARISH_FADE' || signal?.confluence.macd === 'BULLISH';

    setHoldings(prev => prev.map(existing => {
      if (existing.id !== holding.id) return existing;

      if (holding.side === 'LONG') {
        const highestPrice = Math.max(existing.highestPrice || existing.entryPrice, price);
        const trailingStopPrice = runnerStage
          ? Math.max(existing.trailingStopPrice || stopPrice, highestPrice * (1 - trailingBufferPct), stopPrice)
          : (existing.trailingStopPrice || stopPrice);
        return (highestPrice !== existing.highestPrice || trailingStopPrice !== existing.trailingStopPrice)
          ? { ...existing, highestPrice, trailingStopPrice, stopPrice, tp1Price, tp2Price, trailingBufferPct, initialAmount }
          : existing;
      }

      const lowestPrice = Math.min(existing.lowestPrice || existing.entryPrice, price);
      const trailingStopPrice = runnerStage
        ? Math.min(existing.trailingStopPrice || stopPrice, lowestPrice * (1 + trailingBufferPct), stopPrice)
        : (existing.trailingStopPrice || stopPrice);
      return (lowestPrice !== existing.lowestPrice || trailingStopPrice !== existing.trailingStopPrice)
        ? { ...existing, lowestPrice, trailingStopPrice, stopPrice, tp1Price, tp2Price, trailingBufferPct, initialAmount }
        : existing;
    }));

    const technicalInvalidation = margin > 0
      ? currentMarginPnlPct <= -Math.abs(stopLossPercent)
      : (holding.side === 'LONG' ? price <= stopPrice : price >= stopPrice);
    const hitTp1 = holding.side === 'LONG' ? price >= tp1Price : price <= tp1Price;
    const hitTp2 = holding.side === 'LONG' ? price >= tp2Price : price <= tp2Price;
    const trailingStopPrice = holding.trailingStopPrice || stopPrice;
    const trailingBroken = runnerStage && (holding.side === 'LONG' ? price <= trailingStopPrice : price >= trailingStopPrice);
    const weaknessConfirmed = runnerStage && momentumWeakening && (holding.side === 'LONG' ? price < trailingStopPrice : price > trailingStopPrice);

    if (technicalInvalidation) {
      executeTrade(
        closeSide,
        holding.symbol,
        price,
        margin > 0
          ? `AUTO_EXIT: MARGIN STOP ${currentMarginPnlPct.toFixed(2)}% <= -${Math.abs(stopLossPercent).toFixed(2)}%`
          : 'AUTO_EXIT: TECHNICAL INVALIDATION',
        holding.id,
        cycleId,
        undefined,
        holding.amount,
      );
      return;
    }

    if (!tp1Completed && hitTp1) {
      executeTrade(closeSide, holding.symbol, price, 'AUTO_EXIT: TP1 (1R-1.5R)', holding.id, cycleId, undefined, Math.min(holding.amount, initialAmount * 0.5));
      return;
    }

    if (!runnerStage && hitTp2) {
      if (histogramExpanding) {
        executeTrade(closeSide, holding.symbol, price, 'AUTO_EXIT: TP2 (2R-3R)', holding.id, cycleId, undefined, Math.max(0, holding.amount - runnerAmount));
      } else {
        executeTrade(closeSide, holding.symbol, price, 'AUTO_EXIT: TP2 NO MOMENTUM EXPANSION', holding.id, cycleId, undefined, holding.amount);
      }
      return;
    }

    if (trailingBroken) {
      executeTrade(closeSide, holding.symbol, price, 'AUTO_EXIT: TRAILING STRUCTURE', holding.id, cycleId, undefined, holding.amount);
      return;
    }

    if (weaknessConfirmed) {
      executeTrade(closeSide, holding.symbol, price, 'AUTO_EXIT: MOMENTUM WEAKNESS CONFIRMED', holding.id, cycleId, undefined, holding.amount);
    }
  }, [executeTrade, stopLossPercent]);



  const liquidateAll = React.useCallback(async () => {
    if (holdings.length === 0) return;
    
    const confirmed = window.confirm(`LIQUIDATION PROTOCOL: Close all ${holdings.length} active positions at market price?`);
    if (!confirmed) return;
    
    addLog(`LIQUIDATION START: Closing ${holdings.length} vectors...`, 'warning');
    
    const currentPositions = [...holdings];
    let attempted = 0;
    for (const h of currentPositions) {
      const price = holdingPrices[h.symbol] || (h.symbol === symbol ? currentPrice : h.entryPrice);
      if (price) {
        const closeSide: 'BUY' | 'SELL' = h.side === 'SHORT' ? 'BUY' : 'SELL';
        attempted++;
        await executeTrade(closeSide, h.symbol, price, 'EMERGENCY_LIQUIDATION', h.id);
        await new Promise(r => setTimeout(r, 600));
      }
    }

    const unresolved = holdingsRef.current.length;
    if (unresolved > 0) {
      addLog(`LIQUIDATION INCOMPLETE: ${attempted} close orders sent, ${unresolved} positions still open.`, 'warning');
    } else {
      addLog(`LIQUIDATION COMPLETE. All positions closed.`, 'success');
    }
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
    localStorage.setItem('te_available_funds', availableFunds.toString());
    localStorage.setItem('te_holdings', JSON.stringify(holdings));
    localStorage.setItem('te_history', JSON.stringify(tradeHistory));
    localStorage.setItem('te_seed', seedCapital.toString());
    localStorage.setItem('te_benchmark_capital', benchmarkCapital.toString());
    localStorage.setItem('te_auto_trade', autoTrade.toString());
    localStorage.setItem('te_real_mode', isRealMode.toString());
    localStorage.setItem('te_stop_loss_percent', stopLossPercent.toString());
    localStorage.setItem('te_take_profit_percent', takeProfitPercent.toString());
    localStorage.setItem('te_use_bnb_fees', useBNBFees.toString());
    localStorage.setItem('te_max_concurrent_trades', maxConcurrentTrades.toString());
    localStorage.setItem('te_max_drawdown_percent', maxDrawdownPercent.toString());
    localStorage.setItem('te_is_defensive_mode', isDefensiveMode.toString());
    localStorage.setItem('te_auto_entry_min_score', autoEntryMinScore.toString());
    localStorage.setItem('te_live_min_order_notional', liveMinOrderNotional.toString());
    localStorage.setItem('te_live_quote_allowlist', liveQuoteAllowlistInput);
    localStorage.setItem('te_scan_interval_sec', scanIntervalSec.toString());
    localStorage.setItem('te_holding_poll_interval_sec', holdingPollIntervalSec.toString());
    localStorage.setItem('te_max_symbols_per_scan', maxSymbolsPerScan.toString());
    localStorage.setItem('te_duplicate_order_lockout_sec', duplicateOrderLockoutSec.toString());
    localStorage.setItem('te_live_entry_delay_ms', liveEntryDelayMs.toString());
    localStorage.setItem('te_live_entries_per_cycle', liveEntriesPerCycle.toString());
    localStorage.setItem('te_min_paper_allocation', minPaperAllocation.toString());
    localStorage.setItem('te_soft_cooldown_minutes', softCooldownMinutes.toString());
    localStorage.setItem('te_success_cooldown_minutes', successCooldownMinutes.toString());
    localStorage.setItem('te_paper_loss_cooldown_minutes', paperLossCooldownMinutes.toString());
    localStorage.setItem('te_low_margin_lock_minutes', lowMarginLockMinutes.toString());
    localStorage.setItem('te_close_failure_lock_minutes', closeFailureLockMinutes.toString());
    localStorage.setItem('te_hard_failure_lock_minutes', hardFailureLockMinutes.toString());
    localStorage.setItem('te_strategy_config', JSON.stringify(strategyConfig));
  }, [balance, availableFunds, holdings, tradeHistory, seedCapital, benchmarkCapital, autoTrade, isRealMode, stopLossPercent, takeProfitPercent, useBNBFees, maxConcurrentTrades, maxDrawdownPercent, isDefensiveMode, autoEntryMinScore, liveMinOrderNotional, liveQuoteAllowlistInput, scanIntervalSec, holdingPollIntervalSec, maxSymbolsPerScan, duplicateOrderLockoutSec, liveEntryDelayMs, liveEntriesPerCycle, minPaperAllocation, softCooldownMinutes, successCooldownMinutes, paperLossCooldownMinutes, lowMarginLockMinutes, closeFailureLockMinutes, hardFailureLockMinutes, strategyConfig]);

  useEffect(() => {
    localStorage.setItem('te_show_extra_criteria', showExtraCriteria ? '1' : '0');
  }, [showExtraCriteria]);

  useEffect(() => {
    localStorage.setItem('te_scan_full_universe_mode', fullUniverseMode ? '1' : '0');
  }, [fullUniverseMode]);

  // Baseline Safety: If paper trading and baseline is from a ghost real-sync session, fix it.
  useEffect(() => {
    if (!isRealMode && holdings.length === 0 && benchmarkCapital > (balance * 2) && balance === 800) {
      addLog("GHOST BASIS PURGED: Recalibrating laboratory benchmark.", 'info');
      setBenchmarkCapital(balance);
    }
  }, [isRealMode, balance, holdings.length, benchmarkCapital, addLog]);

  useEffect(() => {
    if (!isRealMode) {
      setAvailableFunds(balance);
    }
  }, [isRealMode, balance]);

  const shouldMaintainLiveAccountSync = isRealMode && (autoTrade || holdings.length > 0);

  useEffect(() => {
    if (!shouldMaintainLiveAccountSync) return;
    if (serverStatus !== 'OK') return;
    if (rateLimitedUntilRef.current > Date.now()) return;

    // Keep private account sync off during public scan-only sessions.
    syncRealBalanceRef.current();
    const timer = setInterval(() => {
      syncRealBalanceRef.current();
    }, 15000);

    return () => clearInterval(timer);
  }, [shouldMaintainLiveAccountSync, serverStatus]);

  const currentHolding = holdings.find(h => h.symbol === symbol);
  const stopLossPrice = (currentHolding && currentPrice)
    ? (currentHolding.side === 'SHORT'
      ? currentHolding.entryPrice * (1 + stopLossPercent / 100)
      : currentHolding.entryPrice * (1 - stopLossPercent / 100))
    : 0;

  const [scanProgress, setScanProgress] = useState({ current: 0, total: 0 });
  const [scanSignalSummary, setScanSignalSummary] = useState({
    analyzed: 0,
    shortlisted: 0,
    total: 0,
    buy: 0,
    sell: 0,
    hold: 0,
    notShortlisted: 0,
    unavailable: 0,
    updatedAt: 0,
  });
  const [scanBlockedSummary, setScanBlockedSummary] = useState<{
    updatedAt: number;
    filteredSignals: number;
    reasonCounts: Record<string, number>;
    topBlocked: ScanBlockedSignal[];
  }>({
    updatedAt: 0,
    filteredSignals: 0,
    reasonCounts: {},
    topBlocked: [],
  });
  const [scanDeferredSummary, setScanDeferredSummary] = useState<{
    updatedAt: number;
    deferredSignals: number;
    topDeferred: ScanDeferredSignal[];
  }>({
    updatedAt: 0,
    deferredSignals: 0,
    topDeferred: [],
  });
  const [filteredSyncSymbols, setFilteredSyncSymbols] = useState<Array<{ symbol: string; reason: string }>>([]);
  const [scanDataSource, setScanDataSource] = useState('BINANCE PUBLIC');

  const formatPrice = (price: number) => {
    if (price === 0) return '0.00';
    if (price < 0.0001) return price.toFixed(8);
    if (price < 1) return price.toFixed(6);
    return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
  };

  const formatScanSourceLabel = React.useCallback(() => {
    const snapshot = getPublicDataSourceSnapshot();
    const uniqueSources = Array.from(new Set([
      snapshot.exchangeInfo,
      snapshot.ticker24hr,
      snapshot.klines,
    ].filter(Boolean)));

    if (uniqueSources.length === 0) return 'BINANCE PUBLIC';

    return uniqueSources
      .map(source => source.replace(/_/g, ' '))
      .join(' | ');
  }, []);

  const updateStrategyConfig = React.useCallback((partial: Partial<StrategyConfig>) => {
    setStrategyConfig(prev => ({ ...prev, ...partial }));
  }, []);

  type AiCriteriaSnapshot = {
    autoEntryMinScore: number;
    liveMinOrderNotional: number;
    scanIntervalSec: number;
    holdingPollIntervalSec: number;
    maxSymbolsPerScan: number;
    softCooldownMinutes: number;
    successCooldownMinutes: number;
    paperLossCooldownMinutes: number;
    duplicateOrderLockoutSec: number;
    liveEntryDelayMs: number;
    liveEntriesPerCycle: number;
    minPaperAllocation: number;
    lowMarginLockMinutes: number;
    closeFailureLockMinutes: number;
    hardFailureLockMinutes: number;
    liveQuoteAllowlistInput: string;
    strategyConfig: StrategyConfig;
  };

  const [aiCriteriaPrompt, setAiCriteriaPrompt] = useState('');
  const [aiCriteriaFeedback, setAiCriteriaFeedback] = useState<string | null>(null);
  const [aiCriteriaSnapshot, setAiCriteriaSnapshot] = useState<AiCriteriaSnapshot | null>(() => {
    const saved = localStorage.getItem('te_ai_criteria_snapshot');
    if (!saved) return null;
    try {
      return JSON.parse(saved) as AiCriteriaSnapshot;
    } catch {
      return null;
    }
  });

  const restoreAiCriteriaSnapshot = React.useCallback(() => {
    if (!aiCriteriaSnapshot) {
      setAiCriteriaFeedback('No previous AI behavior snapshot available.');
      return;
    }

    setAutoEntryMinScore(aiCriteriaSnapshot.autoEntryMinScore);
    setLiveMinOrderNotional(aiCriteriaSnapshot.liveMinOrderNotional);
    setScanIntervalSec(aiCriteriaSnapshot.scanIntervalSec);
    setHoldingPollIntervalSec(aiCriteriaSnapshot.holdingPollIntervalSec);
    setMaxSymbolsPerScan(aiCriteriaSnapshot.maxSymbolsPerScan);
    setSoftCooldownMinutes(aiCriteriaSnapshot.softCooldownMinutes);
    setSuccessCooldownMinutes(aiCriteriaSnapshot.successCooldownMinutes);
    setPaperLossCooldownMinutes(aiCriteriaSnapshot.paperLossCooldownMinutes);
    setDuplicateOrderLockoutSec(aiCriteriaSnapshot.duplicateOrderLockoutSec);
    setLiveEntryDelayMs(aiCriteriaSnapshot.liveEntryDelayMs);
    setLiveEntriesPerCycle(aiCriteriaSnapshot.liveEntriesPerCycle);
    setMinPaperAllocation(aiCriteriaSnapshot.minPaperAllocation);
    setLowMarginLockMinutes(aiCriteriaSnapshot.lowMarginLockMinutes);
    setCloseFailureLockMinutes(aiCriteriaSnapshot.closeFailureLockMinutes);
    setHardFailureLockMinutes(aiCriteriaSnapshot.hardFailureLockMinutes);
    setLiveQuoteAllowlistInput(aiCriteriaSnapshot.liveQuoteAllowlistInput);
    setStrategyConfig(aiCriteriaSnapshot.strategyConfig);
    setAiCriteriaSnapshot(null);
    setAiCriteriaFeedback('Restored previous behavior settings.');
  }, [aiCriteriaSnapshot]);

  const resetParametersToDefaults = React.useCallback(() => {
    const confirmed = window.confirm(
      'Reset all trading parameters to default values? This will keep balances, positions, and history intact.'
    );

    if (!confirmed) return;

    setMaxConcurrentTrades(PARAMETER_DEFAULTS.maxConcurrentTrades);
    setTakeProfitPercent(PARAMETER_DEFAULTS.takeProfitPercent);
    setStopLossPercent(PARAMETER_DEFAULTS.stopLossPercent);
    setMaxDrawdownPercent(PARAMETER_DEFAULTS.maxDrawdownPercent);
    setIsDefensiveMode(PARAMETER_DEFAULTS.isDefensiveMode);
    setAutoEntryMinScore(PARAMETER_DEFAULTS.autoEntryMinScore);
    setLiveMinOrderNotional(PARAMETER_DEFAULTS.liveMinOrderNotional);
    setLiveQuoteAllowlistInput(PARAMETER_DEFAULTS.liveQuoteAllowlistInput);
    setScanIntervalSec(PARAMETER_DEFAULTS.scanIntervalSec);
    setHoldingPollIntervalSec(PARAMETER_DEFAULTS.holdingPollIntervalSec);
    setMaxSymbolsPerScan(PARAMETER_DEFAULTS.maxSymbolsPerScan);
    setDuplicateOrderLockoutSec(PARAMETER_DEFAULTS.duplicateOrderLockoutSec);
    setLiveEntryDelayMs(PARAMETER_DEFAULTS.liveEntryDelayMs);
    setLiveEntriesPerCycle(PARAMETER_DEFAULTS.liveEntriesPerCycle);
    setMinPaperAllocation(PARAMETER_DEFAULTS.minPaperAllocation);
    setSoftCooldownMinutes(PARAMETER_DEFAULTS.softCooldownMinutes);
    setSuccessCooldownMinutes(PARAMETER_DEFAULTS.successCooldownMinutes);
    setPaperLossCooldownMinutes(PARAMETER_DEFAULTS.paperLossCooldownMinutes);
    setLowMarginLockMinutes(PARAMETER_DEFAULTS.lowMarginLockMinutes);
    setCloseFailureLockMinutes(PARAMETER_DEFAULTS.closeFailureLockMinutes);
    setHardFailureLockMinutes(PARAMETER_DEFAULTS.hardFailureLockMinutes);
    setFullUniverseMode(PARAMETER_DEFAULTS.fullUniverseMode);
    setStrategyConfig({ ...DEFAULT_STRATEGY_CONFIG });
    setAiCriteriaPrompt('');
    setAiCriteriaSnapshot(null);
    setAiCriteriaFeedback('Reset all parameters to defaults.');
  }, []);

  useEffect(() => {
    if (aiCriteriaSnapshot) {
      localStorage.setItem('te_ai_criteria_snapshot', JSON.stringify(aiCriteriaSnapshot));
    } else {
      localStorage.removeItem('te_ai_criteria_snapshot');
    }
  }, [aiCriteriaSnapshot]);

  const applyAiCriteriaPrompt = React.useCallback(() => {
    const raw = aiCriteriaPrompt.trim();
    if (!raw) {
      setAiCriteriaFeedback('Enter a command first, for example: set scan interval 60, holding poll 8, rsi overbought 72.');
      return;
    }

    const parts = raw
      .split(/\n|;|,|\band\b/gi)
      .map(s => s.trim())
      .filter(Boolean);

    const extractNumber = (text: string) => {
      const match = text.match(/-?\d+(?:\.\d+)?/);
      return match ? parseFloat(match[0]) : null;
    };

    const previousSnapshot: AiCriteriaSnapshot = {
      autoEntryMinScore,
      liveMinOrderNotional,
      scanIntervalSec,
      holdingPollIntervalSec,
      maxSymbolsPerScan,
      softCooldownMinutes,
      successCooldownMinutes,
      paperLossCooldownMinutes,
      duplicateOrderLockoutSec,
      liveEntryDelayMs,
      liveEntriesPerCycle,
      minPaperAllocation,
      lowMarginLockMinutes,
      closeFailureLockMinutes,
      hardFailureLockMinutes,
      liveQuoteAllowlistInput,
      strategyConfig: { ...strategyConfig }
    };

    const touched: string[] = [];
    const strategyPatch: Partial<StrategyConfig> = {};

    for (const partRaw of parts) {
      const part = partRaw.toLowerCase();
      const val = extractNumber(part);

      if (part.includes('auto entry') && val !== null) {
        setAutoEntryMinScore(Math.max(0, Math.min(10, val)));
        touched.push('Auto Entry Score');
      } else if ((part.includes('live notional') || part.includes('min notional')) && val !== null) {
        setLiveMinOrderNotional(Math.max(1, val));
        touched.push('Min Live Notional');
      } else if (part.includes('scan interval') && val !== null) {
        setScanIntervalSec(Math.max(10, Math.round(val)));
        touched.push('Scan Interval');
      } else if ((part.includes('holding poll') || part.includes('poll interval')) && val !== null) {
        setHoldingPollIntervalSec(Math.max(3, Math.round(val)));
        touched.push('Holding Poll');
      } else if ((part.includes('max symbols') || part.includes('symbols per scan')) && val !== null) {
        setMaxSymbolsPerScan(Math.max(20, Math.min(2000, Math.round(val))));
        touched.push('Max Symbols / Scan');
      } else if ((part.includes('soft cooldown')) && val !== null) {
        setSoftCooldownMinutes(Math.max(1, Math.round(val)));
        touched.push('Soft Cooldown');
      } else if ((part.includes('success cooldown')) && val !== null) {
        setSuccessCooldownMinutes(Math.max(1, Math.round(val)));
        touched.push('Success Cooldown');
      } else if ((part.includes('paper loss cooldown') || part.includes('loss cooldown')) && val !== null) {
        setPaperLossCooldownMinutes(Math.max(1, Math.round(val)));
        touched.push('Paper Loss Cooldown');
      } else if ((part.includes('order lockout') || part.includes('duplicate order')) && val !== null) {
        setDuplicateOrderLockoutSec(Math.max(1, Math.round(val)));
        touched.push('Order Lockout');
      } else if ((part.includes('entry delay') || part.includes('live entry delay')) && val !== null) {
        setLiveEntryDelayMs(Math.max(0, Math.round(val)));
        touched.push('Live Entry Delay');
      } else if ((part.includes('entries per cycle') || part.includes('entry cap') || part.includes('live entry cap')) && val !== null) {
        setLiveEntriesPerCycle(Math.max(1, Math.round(val)));
        touched.push('Live Entry Cap');
      } else if ((part.includes('min paper allocation') || part.includes('paper allocation')) && val !== null) {
        setMinPaperAllocation(Math.max(1, val));
        touched.push('Min Paper Allocation');
      } else if (part.includes('low margin lock') && val !== null) {
        setLowMarginLockMinutes(Math.max(1, Math.round(val)));
        touched.push('Low Margin Lock');
      } else if (part.includes('close failure lock') && val !== null) {
        setCloseFailureLockMinutes(Math.max(1, Math.round(val)));
        touched.push('Close Failure Lock');
      } else if (part.includes('hard failure lock') && val !== null) {
        setHardFailureLockMinutes(Math.max(1, Math.round(val)));
        touched.push('Hard Failure Lock');
      } else if (part.includes('rsi overbought') && val !== null) {
        strategyPatch.rsiOverbought = Math.max(50, Math.min(95, val));
        touched.push('RSI Overbought');
      } else if (part.includes('rsi oversold') && val !== null) {
        strategyPatch.rsiOversold = Math.max(5, Math.min(50, val));
        touched.push('RSI Oversold');
      } else if (part.includes('rsi period') && val !== null) {
        strategyPatch.rsiPeriod = Math.max(2, Math.round(val));
        touched.push('RSI Period');
      } else if (part.includes('macd fast') && val !== null) {
        strategyPatch.macdFastPeriod = Math.max(1, Math.round(val));
        touched.push('MACD Fast');
      } else if (part.includes('macd slow') && val !== null) {
        strategyPatch.macdSlowPeriod = Math.max(2, Math.round(val));
        touched.push('MACD Slow');
      } else if (part.includes('macd signal') && val !== null) {
        strategyPatch.macdSignalPeriod = Math.max(1, Math.round(val));
        touched.push('MACD Signal');
      } else if (part.includes('continuation score') && val !== null) {
        strategyPatch.continuationScore = Math.max(0, Math.min(10, val));
        touched.push('Continuation Score');
      } else if (part.includes('trend sma') && val !== null) {
        strategyPatch.trendSmaPeriod = Math.max(2, Math.round(val));
        touched.push('Trend SMA Period');
      } else if (part.includes('ema fast') && val !== null) {
        strategyPatch.emaFastPeriod = Math.max(1, Math.round(val));
        touched.push('EMA Fast Period');
      } else if (part.includes('ema slow') && val !== null) {
        strategyPatch.emaSlowPeriod = Math.max(2, Math.round(val));
        touched.push('EMA Slow Period');
      } else if (part.includes('volume lookback') && val !== null) {
        strategyPatch.volumeLookback = Math.max(2, Math.round(val));
        touched.push('Volume Lookback');
      } else if (part.includes('volume multiplier') && val !== null) {
        strategyPatch.volumeMultiplier = Math.max(0.1, val);
        touched.push('Volume Multiplier');
      } else if (part.includes('support lookback') && val !== null) {
        strategyPatch.supportLookback = Math.max(2, Math.round(val));
        touched.push('Support Lookback');
      } else if (part.includes('near support') && val !== null) {
        strategyPatch.nearSupportPercent = Math.max(0.1, val);
        touched.push('Near Support (%)');
      } else if (part.includes('near resistance') && val !== null) {
        strategyPatch.nearResistancePercent = Math.max(0.1, val);
        touched.push('Near Resistance (%)');
      } else if (part.includes('crossover score') && val !== null) {
        strategyPatch.crossoverScore = Math.max(0, Math.min(10, val));
        touched.push('Crossover Score');
      } else if (part.includes('trend context') && val !== null) {
        strategyPatch.contextTrendScore = Math.max(0, Math.min(10, val));
        touched.push('Trend Context Score');
      } else if (part.includes('volume context') && val !== null) {
        strategyPatch.contextVolumeScore = Math.max(0, Math.min(10, val));
        touched.push('Volume Context Score');
      } else if (part.includes('macd context') && val !== null) {
        strategyPatch.contextMacdScore = Math.max(0, Math.min(10, val));
        touched.push('MACD Context Score');
      } else if (part.includes('ema context') && val !== null) {
        strategyPatch.contextEmaScore = Math.max(0, Math.min(10, val));
        touched.push('EMA Context Score');
      } else if (part.includes('rsi context') && val !== null) {
        strategyPatch.contextRsiScore = Math.max(0, Math.min(10, val));
        touched.push('RSI Context Score');
      } else if (part.includes('max score') && val !== null) {
        strategyPatch.maxScore = Math.max(1, Math.min(10, val));
        touched.push('Max Score');
      } else if (part.includes('quotes')) {
        const quotes = partRaw
          .replace(/.*quotes?/i, '')
          .replace(/[:=]/g, ' ')
          .split(/[\s,]+/)
          .map(s => s.trim().toUpperCase())
          .filter(Boolean)
          .filter(s => /^[A-Z]{3,6}$/.test(s));
        if (quotes.length > 0) {
          setLiveQuoteAllowlistInput(Array.from(new Set(quotes)).join(','));
          touched.push('Allowed Live Quotes');
        }
      }
    }

    if (Object.keys(strategyPatch).length > 0) {
      updateStrategyConfig(strategyPatch);
    }

    if (touched.length === 0) {
      setAiCriteriaFeedback('No recognized criteria were found. Try: scan interval 60, holding poll 8, rsi overbought 72.');
      return;
    }

    setAiCriteriaSnapshot(previousSnapshot);
    setAiCriteriaFeedback(`Updated ${Array.from(new Set(touched)).join(', ')}`);
  }, [
    aiCriteriaPrompt,
    autoEntryMinScore,
    liveMinOrderNotional,
    scanIntervalSec,
    holdingPollIntervalSec,
    maxSymbolsPerScan,
    softCooldownMinutes,
    successCooldownMinutes,
    paperLossCooldownMinutes,
    duplicateOrderLockoutSec,
    liveEntryDelayMs,
    liveEntriesPerCycle,
    minPaperAllocation,
    lowMarginLockMinutes,
    closeFailureLockMinutes,
    hardFailureLockMinutes,
    liveQuoteAllowlistInput,
    strategyConfig,
    updateStrategyConfig
  ]);

  // Emergency Drawdown Watcher
  useEffect(() => {
    if (!isRealMode || holdings.length === 0 || !benchmarkCapital) return;

    // In real mode, `balance` is synced to exchange equity and already includes positions.
    const equity = balance;
    const currentDrawdown = ((benchmarkCapital - equity) / benchmarkCapital) * 100;

    if (currentDrawdown >= maxDrawdownPercent) {
      addLog(`CRITICAL DRAWDOWN DETECTED: ${currentDrawdown.toFixed(2)}% vs ${maxDrawdownPercent}% limit. TRIGGERING SHIELD.`, 'warning');
      const triggerShield = async () => {
         // Force liquidate everything
         for (const h of holdings) {
            const price = holdingPrices[h.symbol] || h.entryPrice;
          const closeSide: 'BUY' | 'SELL' = h.side === 'SHORT' ? 'BUY' : 'SELL';
          await executeTrade(closeSide, h.symbol, price, 'EMERGENCY_SHIELD: MAX DRAWDOWN REACHED', h.id);
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
  const performScan = React.useCallback(async (manual = false) => {
    if (scanningRef.current) return;
    if (!manual && !autoTradeRef.current) return;
    if (rateLimitedUntilRef.current > Date.now()) {
      setScanProgress({ current: 0, total: 0 });
      return;
    }
    const cycleId = Date.now();
    currentScanCycleRef.current = cycleId;
    setScanExecutionStats({ cycleId, attempted: 0, filled: 0, failed: 0, skipped: 0 });
    scanningRef.current = true;
    setScanning(true);
    setIsBotActive(true);
    try {
      setScanProgress({ current: 0, total: 0 });
      let allSymbols: { label: string; value: string }[];
      let liveTradableSymbols = new Set<string>(liveTradableSymbolsRef.current);
      try {
        const [universeSymbols, futuresOnlySymbols] = await Promise.all([
          fetchAllSymbols({
            includeSpot: true,
            includeFutures: true,
            fullUniverse: true,
            allowedQuotes: liveQuoteAllowlist,
            forceBinancePublic: true,
          }),
          fetchAllSymbols({
            includeSpot: false,
            includeFutures: true,
            fullUniverse: true,
            allowedQuotes: liveQuoteAllowlist,
            forceBinancePublic: true,
          }),
        ]);
        allSymbols = universeSymbols;
        liveTradableSymbols = new Set(futuresOnlySymbols.map(s => normalizeLiveFuturesSymbol(s.value)));
        setScanDataSource(formatScanSourceLabel());
        if (liveTradableSymbols.size > 0) {
          liveTradableSymbolsRef.current = liveTradableSymbols;
          liveTradableSymbolsFetchedAtRef.current = Date.now();
        }
      } catch (err: any) {
        const retryAt: number = err?.retryAt || 0;
        if (retryAt > Date.now()) {
          setRateLimitUntil(retryAt);
        }
        const msg = retryAt > Date.now()
          ? `Scanner blocked: Binance rate limit active. Retry at ${new Date(retryAt).toLocaleTimeString()}.`
          : 'Scanner idle: failed to load symbol list.';
        addLog(msg, 'warning');
        setExecutionFeedback({ type: 'warning', message: msg });
        setScanProgress({ current: 0, total: 0 });
        return;
      }
      const allValues = allSymbols.map(s => s.value);
      const liveNormalized = (v: string) => normalizeLiveFuturesSymbol(v);
      const nonTradableStableBases = new Set(['USDT', 'USDC', 'BUSD', 'TUSD', 'USDP', 'FDUSD']);
      const hasAllowedQuote = (v: string) => {
        const up = v.toUpperCase();
        return liveQuoteAllowlist.some((q: string) => up.endsWith(q));
      };
      const hasTradableBase = (v: string) => {
        const up = v.toUpperCase();
        const quote = liveQuoteAllowlist.find((q: string) => up.endsWith(q)) || (up.endsWith('FDUSD') ? 'FDUSD' : '');
        if (!quote) return true;
        const base = up.slice(0, -quote.length);
        return Boolean(base) && !nonTradableStableBases.has(base);
      };
      const isLikelyBinanceFuturesSymbol = (v: string) => {
        const up = v.toUpperCase();
        const validSuffixes = /^[A-Z0-9]+?(USDT|USDC|FDUSD|BTC|ETH|BNB)$/;
        return validSuffixes.test(up) && up.length < 20 && !/[^A-Z0-9]/.test(up);
      };
      const isLikelyBinanceSymbol = (v: string) => /^[A-Z0-9]{5,24}$/.test(v.toUpperCase());
      const normalizedLiveExchange = String(serverConfig?.exchange || '').toLowerCase();
      const isLiveBinance = isRealMode && normalizedLiveExchange === 'binance';
      const baseSymbol = isRealMode ? liveNormalized(symbol) : symbol;
      const candidateValues = isRealMode ? allValues.map(liveNormalized) : allValues;
      const isLiveTradableFuturesSymbol = (value: string) => liveTradableSymbols.has(normalizeLiveFuturesSymbol(value));
      let symbolsToScan = isLiveBinance
        ? Array.from(new Set(candidateValues)).filter(value => isLikelyBinanceSymbol(value) && hasTradableBase(value))
        : Array.from(new Set([baseSymbol, ...candidateValues]));

      if (symbolsToScan.length === 0) {
        setScanProgress({ current: 0, total: 0 });
        addLog('Scanner idle: no symbols available to scan.', 'warning');
        return;
      }
      
      const totalToScan = symbolsToScan.length;
      setScanProgress({ current: 0, total: totalToScan });
      const prioritySymbols = Array.from(new Set([
        baseSymbol,
        ...holdingsRef.current.map(h => h.symbol),
      ].filter(Boolean)));
      const shortlistLimit = totalToScan;
      
      let lastLoggedCount = 0;
      const results = await scanMarket(
        symbolsToScan,
        (current, total) => {
        const safeTotal = total > 0 ? total : totalToScan;
        const safeCurrent = Math.min(Math.max(current, 0), safeTotal);
        setScanProgress({ current: safeCurrent, total: safeTotal });
        // Log every 50 assets to keep "pulse" visible
        if (safeCurrent >= lastLoggedCount + 50 || safeCurrent === safeTotal) {
          lastLoggedCount = safeCurrent;
        }
        },
        () => rateLimitedUntilRef.current <= Date.now() && (manual || autoTradeRef.current),
        strategyConfig,
        {
          shortlistLimit,
          prioritySymbols,
          onRateLimit: (retryAt) => {
            if (retryAt > Date.now()) {
              setRateLimitUntil(retryAt);
            }
          },
        },
      );
      setScanDataSource(formatScanSourceLabel());

      if ((!manual && !autoTradeRef.current) || rateLimitedUntilRef.current > Date.now()) {
        setScanProgress({ current: 0, total: 0 });
        return;
      }

      setMarketPicks(results);
      const signalCounts = results.reduce((acc, row) => {
        const key = row.signal.overall;
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, { BUY: 0, SELL: 0, HOLD: 0 } as Record<'BUY' | 'SELL' | 'HOLD', number>);
      setScanSignalSummary({
        analyzed: results.length,
        shortlisted: shortlistLimit,
        total: symbolsToScan.length,
        buy: signalCounts.BUY,
        sell: signalCounts.SELL,
        hold: signalCounts.HOLD,
        notShortlisted: Math.max(0, symbolsToScan.length - shortlistLimit),
        unavailable: Math.max(0, shortlistLimit - results.length),
        updatedAt: Date.now(),
      });
      const scanSummary = `SCAN SUMMARY: ${results.length}/${symbolsToScan.length} analyzed | BUY=${signalCounts.BUY} SELL=${signalCounts.SELL} HOLD=${signalCounts.HOLD}`;
      addLog(
        scanSummary,
        signalCounts.BUY > 0 || signalCounts.SELL > 0 ? 'success' : 'info'
      );
      console.log(`[TradeEdge] ${scanSummary}`);
      // Wait a moment before resetting progress to let the user see "Complete" in the UI
      setTimeout(() => setScanProgress({ current: 0, total: 0 }), 3000);
      
      const currentAutoTrade = autoTradeRef.current;
      const currentHoldings = holdingsRef.current;
      const currentMaxTrades = maxConcurrentTradesRef.current;
      const entryLockActive = entryLockUntilRef.current > Date.now();
      const scanNow = Date.now();

      const signalCandidates = results
        .filter(r => r.signal.overall === 'BUY' || (isRealMode && r.signal.overall === 'SELL'))
        .map(pick => ({ side: pick.signal.overall === 'SELL' ? 'SELL' as const : 'BUY' as const, pick }));

      const getEntryBlockReason = ({ pick }: { side: 'BUY' | 'SELL'; pick: MarketScanResult }) => {
        if (isLiveBinance && !isLikelyBinanceFuturesSymbol(pick.symbol)) {
          return 'invalid futures symbol format';
        }
        if (isLiveBinance && !fullUniverseMode && !hasAllowedQuote(pick.symbol)) {
          return `outside focused quote universe [${liveQuoteAllowlist.join(', ')}]`;
        }
        if (isLiveBinance && !isLiveTradableFuturesSymbol(pick.symbol)) {
          return 'not in Binance futures tradable set';
        }
        if (currentHoldings.some(h => h.symbol === pick.symbol)) {
          return 'already held';
        }
        const cooldownUntil = cooldowns[pick.symbol] || 0;
        if (cooldownUntil > scanNow) {
          const minutesRemaining = Math.max(1, Math.ceil((cooldownUntil - scanNow) / 60000));
          return `cooldown ${minutesRemaining}m remaining`;
        }
        if (isLiveBinance && isNonTradableQuoteBaseSymbol(pick.symbol)) {
          return 'quote asset treated as cash';
        }
        if (isLiveBinance && isUnsupportedLiveScanSymbol(pick.symbol)) {
          return 'unsupported market quarantine';
        }
        return null;
      };

      const blockedSignals = signalCandidates
        .map(({ side, pick }) => ({
          symbol: pick.symbol,
          side,
          score: pick.signal.score,
          priorityRank: pick.priorityRank || 0,
          reason: getEntryBlockReason({ side, pick }),
        }))
        .filter((entry): entry is ScanBlockedSignal => Boolean(entry.reason))
        .sort((a, b) => {
          const directionalScoreDelta = getDirectionalEntryScore(b.side, b.score) - getDirectionalEntryScore(a.side, a.score);
          if (directionalScoreDelta !== 0) return directionalScoreDelta;
          return b.priorityRank - a.priorityRank;
        });

      setScanBlockedSummary({
        updatedAt: scanNow,
        filteredSignals: blockedSignals.length,
        reasonCounts: blockedSignals.reduce<Record<string, number>>((acc, entry) => {
          acc[entry.reason] = (acc[entry.reason] || 0) + 1;
          return acc;
        }, {}),
        topBlocked: blockedSignals.slice(0, 6),
      });
      setScanDeferredSummary({
        updatedAt: scanNow,
        deferredSignals: 0,
        topDeferred: [],
      });

      if (currentAutoTrade && isRealMode && entryLockActive) {
        const remainingSec = Math.max(1, Math.ceil((entryLockUntilRef.current - Date.now()) / 1000));
        pushScanSkipEvent(`SKIP: Entry lock active (${remainingSec}s remaining) after close-order failures`, cycleId);
        return;
      }

      if (currentAutoTrade && currentHoldings.length > 0) {
        currentHoldings.forEach(holding => {
          const scanResult = results.find(r => r.symbol === holding.symbol);
          if (scanResult) {
            managePlannedExit(holding, scanResult.lastPrice, scanResult.signal, cycleId);
          }
        });
      }

      if (currentAutoTrade) {
        if (isLiveBinance && liveTradableSymbols.size === 0) {
          pushScanSkipEvent('SKIP: Binance futures tradable symbol set unavailable; blocking new live entries until metadata refresh succeeds.', cycleId);
          return;
        }

        const entries = signalCandidates
          .filter(entry => !getEntryBlockReason(entry))
          .sort((a, b) => {
            const directionalScoreDelta = getDirectionalEntryScore(b.side, b.pick.signal.score) - getDirectionalEntryScore(a.side, a.pick.signal.score);
            if (directionalScoreDelta !== 0) return directionalScoreDelta;
            return (b.pick.priorityRank || 0) - (a.pick.priorityRank || 0);
          });
        const eligibleBuyCount = entries.filter(entry => entry.side === 'BUY').length;
        const eligibleSellCount = entries.filter(entry => entry.side === 'SELL').length;

        if (currentHoldings.length < currentMaxTrades) {
          const availableSlots = currentMaxTrades - currentHoldings.length;
          const realFreeCapital = Math.max(0, availableFunds * 0.95);
          const realTradableCapital = realFreeCapital;
          if (isRealMode && realTradableCapital < liveMinOrderNotional) {
            const marginLockUntil = Date.now() + (lowMarginLockMinutes * 60 * 1000);
            setEntryLockUntil(prev => Math.max(prev, marginLockUntil));
            pushScanSkipEvent(`SKIP: Free margin too low for minimum order ($${realFreeCapital.toFixed(2)} effective $${realTradableCapital.toFixed(2)} < $${liveMinOrderNotional.toFixed(2)})`, cycleId);
            return;
          }
          const toTrade = entries.slice(0, availableSlots);
          const selectedCount = toTrade.length;
          const deferredCount = 0;
          const coverageSummary = `coverage=${results.length}/${shortlistLimit}/${symbolsToScan.length}`;
          addLog(
            `SCAN DECISION: found=${signalCandidates.length} eligible=${entries.length} blocked=${blockedSignals.length} deferred=${deferredCount} selected=${selectedCount} ${coverageSummary}`,
            selectedCount > 0 ? 'success' : 'info',
          );
          
          if (toTrade.length > 0) {
            // Live mode safety: execute entries sequentially to avoid burst margin failures.
            const selectedTrades = toTrade;
            setScanDeferredSummary({
              updatedAt: scanNow,
              deferredSignals: 0,
              topDeferred: [],
            });
            for (const { side, pick } of selectedTrades) {
              if (isLiveBinance && isNonTradableQuoteBaseSymbol(pick.symbol)) {
                pushScanSkipEvent(`SKIP: ${pick.symbol} blocked because quote assets are treated as cash, not tradable base positions`, cycleId);
                continue;
              }
              if (isLiveBinance && !isLiveTradableFuturesSymbol(pick.symbol)) {
                pushScanSkipEvent(`SKIP: ${pick.symbol} not present in Binance futures tradable symbol set`, cycleId);
                continue;
              }
              if (isLiveBinance && isUnsupportedLiveScanSymbol(pick.symbol)) {
                pushScanSkipEvent(`SKIP: ${pick.symbol} blocked by unsupported market quarantine`, cycleId);
                continue;
              }
              const entryType = side === 'BUY' ? 'LONG' : 'SHORT';
              await executeTrade(side, pick.symbol, pick.lastPrice, `AI ${entryType} DISCOVERY: CONFIDENCE ${pick.signal.score}/10`, undefined, cycleId, pick.signal.tradePlan);
              if (!autoTradeRef.current || entryLockUntilRef.current > Date.now()) break;
              if (isRealMode) {
                await new Promise(r => setTimeout(r, liveEntryDelayMs));
              }
            }
          } else {
            pushScanSkipEvent(`SKIP: No eligible entries (BUY=${eligibleBuyCount}, SELL=${eligibleSellCount}, slots=${availableSlots})`, cycleId);
          }
        } else {
          pushScanSkipEvent(`SKIP: No free slots (${currentHoldings.length}/${currentMaxTrades})`, cycleId);
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
  }, [symbol, executeTrade, stopLossPercent, takeProfitPercent, addLog, isRealMode, cooldowns, serverConfig?.exchange, pushScanSkipEvent, availableFunds, balance, setRateLimitUntil, autoEntryMinScore, liveMinOrderNotional, lowMarginLockMinutes, liveEntryDelayMs, liveEntriesPerCycle, strategyConfig, liveQuoteAllowlistInput, fullUniverseMode, isUnsupportedLiveScanSymbol]);
 // Removed 'scanning' from dependencies

  const resetAccount = React.useCallback(() => {
    setBalance(seedCapital);
    setAvailableFunds(seedCapital);
    setBenchmarkCapital(seedCapital);
    setHoldings([]);
    setTradeHistory([]);
    setSystemLogs([]);
    localStorage.clear();
    localStorage.setItem('te_seed', seedCapital.toString());
    localStorage.setItem('te_benchmark_capital', seedCapital.toString());
    localStorage.setItem('te_available_funds', seedCapital.toString());
    addLog(`Laboratory reset: Initializing with $${seedCapital} capital.`, 'info');
  }, [seedCapital, addLog]);

  useEffect(() => {
    const initSymbols = async () => {
      if (serverStatus !== 'OK') return;
      if (!autoTradeRef.current || rateLimitedUntilRef.current > Date.now()) {
        setAvailableSymbols([]);
        return;
      }
      try {
        const all = await fetchAllSymbols({
          includeSpot: true,
          includeFutures: true,
          fullUniverse: true,
          allowedQuotes: liveQuoteAllowlist,
          forceBinancePublic: true,
        });
        setScanDataSource(formatScanSourceLabel());
        setAvailableSymbols(all);
        addLog(`Market Metadata: ${all.length} exchange vectors mapped.`, 'info');
      } catch (err: any) {
        const retryAt: number = err?.retryAt || 0;
        if (retryAt > Date.now()) {
          setRateLimitUntil(retryAt);
          addLog(`Scanner blocked: Binance rate limit active. Retry at ${new Date(retryAt).toLocaleTimeString()}.`, 'warning');
        } else {
          addLog('Market Metadata: symbol map unavailable.', 'warning');
        }
      }
      addLog(`PROTOCOL STATUS: Autonomous Execution is ${autoTrade ? 'ACTIVE' : 'IDLE'}`, autoTrade ? 'success' : 'info');
    };
    initSymbols();
  }, [addLog, autoTrade, fullUniverseMode, liveQuoteAllowlistInput, setRateLimitUntil, serverStatus]);

  // Main Data Loading & Scanner Auto-Refresh
  useEffect(() => {
    if (serverStatus !== 'OK') return;

    const loadData = async (silent = false) => {
      if (rateLimitedUntilRef.current > Date.now()) {
        if (!silent) setLoading(false);
        return;
      }
      // ONLY show the dark loading screen if we have zero data (initial boot or fresh asset)
      if (!silent && data.length === 0) setLoading(true); 
      
      try {
        const candles = await fetchBinanceData(symbol, STRATEGY_SIGNAL_INTERVAL, 500);
        setData(candles);
        // For daily strategy decisions, use the last fully closed candle.
        const signalCandles = candles.length > 2 ? candles.slice(0, -1) : candles;
        const inds = calculateIndicators(signalCandles, strategyConfig);
        setIndicators(inds);
        const sig = evaluateStrategy(signalCandles, inds, strategyConfig);
        setStrategy(sig);
        if (candles.length > 0) {
          const price = candles[candles.length - 1].close;
          setCurrentPrice(price);
          setHoldingPrices(prev => ({ ...prev, [symbol]: price }));
        }
      } catch (err) {
        const retryAt = Number((err as any)?.retryAt || 0);
        if (retryAt > Date.now()) {
          setRateLimitUntil(retryAt);
        }
        console.error("Data load failed", err);
      } finally {
        setLoading(false);
      }
    };

    loadData();
    if (autoTradeRef.current) performScan();

    const refreshInterval = setInterval(() => {
      loadData(true);
      if (autoTradeRef.current) {
        performScan();
        setNextScanSec(scanIntervalSec);
      } else {
        setNextScanSec(0);
      }
    }, scanIntervalSec * 1000);

    const countdownInterval = setInterval(() => {
      setNextScanSec(prev => Math.max(0, prev - 1));
    }, 1000);

    const useBinanceWsTicker = isRealMode && serverConfig?.exchange === 'binance';
    const unsubscribe = subscribeToTicker(
      symbol,
      (price) => {
        setCurrentPrice(price);
      },
      { preferWebSocket: useBinanceWsTicker }
    );

    return () => {
      unsubscribe();
      clearInterval(refreshInterval);
      clearInterval(countdownInterval);
    };
  }, [symbol, performScan, isRealMode, serverConfig?.exchange, serverStatus, scanIntervalSec, strategyConfig]);

  // Dedicated Portfolio Price Watcher (High Frequency)
  useEffect(() => {
    if (holdings.length === 0) return;
    if (serverStatus !== 'OK') return;

    const pollHoldingPrices = async () => {
      if (rateLimitedUntilRef.current > Date.now()) return;
      const updates: Record<string, number> = {};
      await Promise.all(holdings.map(async (h) => {
        try {
          const lastPrice = await fetchLatestPrice(h.symbol);
          if (lastPrice) {
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

    const interval = setInterval(pollHoldingPrices, Math.max(10, holdingPollIntervalSec) * 1000);
    pollHoldingPrices();

    return () => clearInterval(interval);
  }, [holdings, serverStatus, holdingPollIntervalSec]);

  useEffect(() => {
    if (holdings.length > 0) {
      holdings.forEach(holding => {
        const price = holdingPrices[holding.symbol] || (holding.symbol === symbol ? currentPrice : null);
        
        if (price) {
          managePlannedExit(holding, price, strategy);
        }
      });
    }
    
    // 4. Current Symbol Auto-Entry (paper mode only)
    const paperEntryQualified = strategy && (
      (strategy.overall === 'BUY' && strategy.score >= Math.max(autoEntryMinScore, 7.2))
      || (strategy.overall === 'SELL' && strategy.score <= Math.min(10 - autoEntryMinScore, 2.8))
    );
    if (!isRealMode && holdings.length < maxConcurrentTrades && strategy && (strategy.overall === 'BUY' || strategy.overall === 'SELL') && autoTrade && currentPrice && paperEntryQualified) {
      const isAlreadyHeld = holdings.some(h => h.symbol === symbol);
      const isOnCooldown = cooldowns[symbol] && cooldowns[symbol] > Date.now();
      if (!isAlreadyHeld && !isOnCooldown) {
        const entrySide: 'BUY' | 'SELL' = strategy.overall === 'SELL' ? 'SELL' : 'BUY';
        const entryType = entrySide === 'SELL' ? 'SHORT' : 'LONG';
        executeTrade(entrySide, symbol, currentPrice, `AUTO_ENTRY: ${entryType} SIGNAL [${strategy.score}/10]`, undefined, undefined, strategy.tradePlan);
      }
    }
  }, [currentPrice, strategy, autoTrade, holdings, symbol, executeTrade, maxConcurrentTrades, holdingPrices, cooldowns, isRealMode, managePlannedExit]);

  const calculateEquity = () => {
    if (isRealMode) {
      return balance;
    }

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
  const resolveHoldingPnl = (h: Holding) => {
    const mark = h.markPrice || holdingPrices[h.symbol] || (h.symbol === symbol ? currentPrice : h.entryPrice) || h.entryPrice;
    const contracts = Number(h.contracts || h.amount || 0);
    const move = h.side === 'SHORT' ? (h.entryPrice - mark) : (mark - h.entryPrice);
    const computedPnl = move * contracts;
    const exchangePnl = Number(h.unrealizedPnl);
    const hasExchangePnl = Number.isFinite(exchangePnl);
    const hasMeaningfulPriceMove = Math.abs(mark - h.entryPrice) > Math.max(Math.abs(h.entryPrice) * 1e-8, 1e-8);
    const signMismatch = hasExchangePnl
      && hasMeaningfulPriceMove
      && Math.abs(computedPnl) > 1e-8
      && Math.abs(exchangePnl) > 1e-8
      && Math.sign(computedPnl) !== Math.sign(exchangePnl);
    const pnl = !hasExchangePnl || signMismatch || (Math.abs(exchangePnl) < 1e-12 && hasMeaningfulPriceMove)
      ? computedPnl
      : exchangePnl;

    return { mark, contracts, pnl };
  };

  const computedUnrealizedPnl = holdings.reduce((sum, h) => {
    return sum + resolveHoldingPnl(h).pnl;
  }, 0);
  const hasOpenPositions = holdings.length > 0;
  const displayedUnrealizedRisk = isRealMode
    ? (hasOpenPositions ? computedUnrealizedPnl : liveUnrealizedPnl)
    : computedUnrealizedPnl;
  const scanDisplayTotal = scanProgress.total > 0 ? scanProgress.total : availableSymbols.length;
  const scanProgressPct = scanProgress.total > 0
    ? Math.min(100, Math.max(0, (scanProgress.current / scanProgress.total) * 100))
    : 0;
  const isScanPreparing = scanning && scanProgress.total === 0;
  const scanStatusHint = (() => {
    if (!autoTrade) return 'Auto trading is OFF. Scans only run when manually triggered.';
    if (rateLimitedUntilRef.current > Date.now()) return `Scanner paused by rate-limit until ${new Date(rateLimitedUntilRef.current).toLocaleTimeString()}.`;
    if (scanning) return 'Scanner cycle is currently running.';
    if (scanSignalSummary.updatedAt === 0) return 'No completed scan cycle yet in this session.';
    return `Last completed scan at ${new Date(scanSignalSummary.updatedAt).toLocaleTimeString()}.`;
  })();
  const scanSourceHint = `Scan Source: ${scanDataSource}`;
  const scanUniverseHint = fullUniverseMode
    ? `Full Universe Mode: scanning all Binance futures quotes; live entries remain restricted to ${liveQuoteAllowlist.join(', ')}.`
    : `Focused quote universe: scanning all discovered symbols, but live entries remain restricted to ${liveQuoteAllowlist.join(', ')}.`;
  const scanCoverageHint = scanSignalSummary.updatedAt === 0
    ? 'Coverage: no completed scan yet.'
    : scanSignalSummary.notShortlisted > 0
      ? `Coverage: analyzed ${scanSignalSummary.analyzed}/${scanSignalSummary.shortlisted} shortlisted assets from ${scanSignalSummary.total} in universe; ${scanSignalSummary.notShortlisted} were not analyzed this cycle.`
      : scanSignalSummary.unavailable > 0
        ? `Coverage: analyzed ${scanSignalSummary.analyzed}/${scanSignalSummary.shortlisted} shortlisted assets; ${scanSignalSummary.unavailable} returned no usable scan result.`
        : `Coverage: analyzed ${scanSignalSummary.analyzed}/${scanSignalSummary.total} assets this cycle.`;
  const filteredSyncSymbolsPreview = filteredSyncSymbols.slice(0, 3).map((entry: { symbol: string; reason: string }) => entry.symbol).join(', ');
  const filteredSyncNote = filteredSyncSymbols.length > 0
    ? `Exchange sync filtered ${filteredSyncSymbols.length} non-tradable raw symbol${filteredSyncSymbols.length === 1 ? '' : 's'}${filteredSyncSymbolsPreview ? `: ${filteredSyncSymbolsPreview}${filteredSyncSymbols.length > 3 ? ', ...' : ''}.` : '.'} USDT remains available as cash in Cash / Available Funds and is not shown as an active position.`
    : '';
  
  // Anti-Glitich: If equity is non-finite or impossible, it's a data core issue
  // We cap at $100,000,000 to allow "Whale" mode while still blocking glitches
  const isDataBroken = !isFinite(equity) || equity > 100000000 || equity < 0; 
  
  const pnl = equity - benchmarkCapital;
  const pnlPercent = benchmarkCapital > 0 ? (pnl / benchmarkCapital) * 100 : 0;
  const totalPnl = pnl;
  const openPnl = displayedUnrealizedRisk;
  const realizedPnl = totalPnl - openPnl;
  const displayedAvailableFunds = isRealMode ? availableFunds : balance;
  const usedCapital = Math.max(0, equity - displayedAvailableFunds);
  const investedPct = equity > 0
    ? Math.min(100, Math.max(0, (usedCapital / equity) * 100))
    : 0;
  const entryLockActive = entryLockUntil > Date.now();
  const entryLockRemainingSec = entryLockActive ? Math.max(1, Math.ceil((entryLockUntil - Date.now()) / 1000)) : 0;
  const entryLockRetryTime = entryLockActive ? new Date(entryLockUntil).toLocaleTimeString() : '';
  const syncErrorLower = (syncError || '').toLowerCase();
  const isAuthDisabledBannerVisible = entryLockActive && (
    syncErrorLower.includes('auth error') ||
    syncErrorLower.includes('api key') ||
    syncErrorLower.includes('enable futures') ||
    syncErrorLower.includes('-2015')
  );
  const isAuthDegradedBannerVisible = isRealMode && !isAuthDisabledBannerVisible && Boolean(authDegradedMessage);
  const authLockMinutes = Math.floor(entryLockRemainingSec / 60);
  const authLockSeconds = String(entryLockRemainingSec % 60).padStart(2, '0');

  const activePositionSortDirection = React.useCallback((key: ActivePositionSortKey) => {
    return activePositionSortRules.find(rule => rule.key === key)?.direction;
  }, [activePositionSortRules]);

  const activePositionSortPriority = React.useCallback((key: ActivePositionSortKey) => {
    const index = activePositionSortRules.findIndex(rule => rule.key === key);
    return index >= 0 ? index + 1 : null;
  }, [activePositionSortRules]);

  const updateActivePositionSort = React.useCallback((key: ActivePositionSortKey, additive: boolean) => {
    setActivePositionSortRules(prev => {
      const existingIndex = prev.findIndex(rule => rule.key === key);

      if (!additive) {
        if (existingIndex === -1) return [{ key, direction: 'asc' }];
        const existing = prev[existingIndex];
        if (existing.direction === 'asc') return [{ key, direction: 'desc' }];
        return [];
      }

      if (existingIndex === -1) {
        return [...prev, { key, direction: 'asc' }];
      }

      const next = [...prev];
      const existing = next[existingIndex];
      if (existing.direction === 'asc') {
        next[existingIndex] = { ...existing, direction: 'desc' };
        return next;
      }

      next.splice(existingIndex, 1);
      return next;
    });
  }, []);

  const activePositionRows = React.useMemo(() => {
    return holdings.map((h, index) => {
      const { mark, contracts, pnl: pnlVal } = resolveHoldingPnl(h);
      const notional = Number(h.notional || (contracts * h.entryPrice) || 0);
      const margin = Number(h.initialMargin || (notional > 0 ? notional / 5 : 0) || 0);
      const pnlPctVal = margin > 0 ? (pnlVal / margin) * 100 : 0;
      const closeSide: 'BUY' | 'SELL' = h.side === 'SHORT' ? 'BUY' : 'SELL';
      const displaySymbol = h.displaySymbol || (h.symbol.endsWith('USDT')
        ? `${h.symbol.slice(0, -4)}/USDT:USDT`
        : h.symbol.endsWith('USDC')
          ? `${h.symbol.slice(0, -4)}/USDC:USDC`
          : h.symbol);

      return {
        holding: h,
        index,
        displaySymbol,
        exchange: h.exchange || 'Binance',
        side: h.side,
        contracts,
        entryPrice: Number(h.entryPrice || 0),
        mark,
        margin,
        notional,
        unrealizedPnl: pnlVal,
        pnlPct: pnlPctVal,
        closeSide,
      };
    });
  }, [holdings, resolveHoldingPnl]);

  const sortedActivePositionRows = React.useMemo(() => {
    if (activePositionSortRules.length === 0) return activePositionRows;

    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const normalized = [...activePositionRows];

    normalized.sort((a, b) => {
      for (const rule of activePositionSortRules) {
        let cmp = 0;

        switch (rule.key) {
          case 'exchange':
            cmp = collator.compare(a.exchange, b.exchange);
            break;
          case 'side':
            cmp = collator.compare(a.side, b.side);
            break;
          case 'symbol':
            cmp = collator.compare(a.displaySymbol, b.displaySymbol);
            break;
          case 'contracts':
            cmp = a.contracts - b.contracts;
            break;
          case 'entryPrice':
            cmp = a.entryPrice - b.entryPrice;
            break;
          case 'markPrice':
            cmp = a.mark - b.mark;
            break;
          case 'margin':
            cmp = a.margin - b.margin;
            break;
          case 'notional':
            cmp = a.notional - b.notional;
            break;
          case 'unrealizedPnl':
            cmp = a.unrealizedPnl - b.unrealizedPnl;
            break;
          case 'pnlPct':
            cmp = a.pnlPct - b.pnlPct;
            break;
          case 'action':
            cmp = collator.compare(a.closeSide, b.closeSide);
            break;
          default:
            cmp = 0;
            break;
        }

        if (cmp !== 0) {
          return rule.direction === 'asc' ? cmp : -cmp;
        }
      }

      return a.index - b.index;
    });

    return normalized;
  }, [activePositionRows, activePositionSortRules]);

  const activePositionHeaders: Array<{
    key: ActivePositionSortKey;
    label: string;
    rightAlign?: boolean;
  }> = [
    { key: 'exchange', label: 'Exchange' },
    { key: 'side', label: 'Side' },
    { key: 'symbol', label: 'Symbol' },
    { key: 'contracts', label: 'Contracts' },
    { key: 'entryPrice', label: 'Entry Price' },
    { key: 'markPrice', label: 'Mark Price' },
    { key: 'margin', label: 'Margin' },
    { key: 'notional', label: 'Notional' },
    { key: 'unrealizedPnl', label: 'Unrealized P&L' },
    { key: 'pnlPct', label: 'P&L %' },
    { key: 'action', label: 'Action Control', rightAlign: true },
  ];

  const heldSymbols = React.useMemo(() => {
    return new Set(holdings.map(h => String(h.symbol || '').toUpperCase()));
  }, [holdings]);

  const latestTradeBySymbol = React.useMemo(() => {
    const latest = new Map<string, TradeEvent>();
    for (const trade of tradeHistory) {
      const key = String(trade.symbol || '').toUpperCase();
      if (!key || latest.has(key)) continue;
      latest.set(key, trade);
    }
    return latest;
  }, [tradeHistory]);

  const getMarketPickLifecycle = React.useCallback((pick: MarketScanResult): MarketPickLifecycle => {
    const normalizedSymbol = String(pick.symbol || '').toUpperCase();
    if (heldSymbols.has(normalizedSymbol)) {
      return {
        label: 'Exchange Confirmed',
        className: 'bg-emerald-100 text-emerald-800',
      };
    }

    const latestTrade = latestTradeBySymbol.get(normalizedSymbol);
    const reason = String(latestTrade?.reason || '').toUpperCase();
    if (latestTrade?.type === 'BUY' && reason.includes('UNCONFIRMED')) {
      return {
        label: 'Order Submitted',
        className: 'bg-amber-100 text-amber-800',
      };
    }

    if (pick.signal.overall === 'BUY' || pick.signal.overall === 'SELL') {
      return {
        label: 'Signal Found',
        className: pick.signal.overall === 'SELL'
          ? 'bg-rose-100 text-rose-800'
          : 'bg-sky-100 text-sky-800',
      };
    }

    return {
      label: 'Watching',
      className: 'bg-gray-100 text-gray-500',
    };
  }, [heldSymbols, latestTradeBySymbol]);

  const marketPickLifecycleSummary = React.useMemo(() => {
    let signalFound = 0;
    let orderSubmitted = 0;
    let exchangeConfirmed = 0;

    for (const pick of marketPicks) {
      const lifecycle = getMarketPickLifecycle(pick);
      if (pick.signal.overall === 'BUY' || pick.signal.overall === 'SELL') signalFound += 1;
      if (lifecycle.label === 'Order Submitted') orderSubmitted += 1;
      if (lifecycle.label === 'Exchange Confirmed') exchangeConfirmed += 1;
    }

    return {
      signalFound,
      orderSubmitted,
      exchangeConfirmed,
      openPositions: holdings.length,
    };
  }, [getMarketPickLifecycle, holdings.length, marketPicks]);

  const visibleTradeHistory = tradeHistory.filter(t => {
    // Hide SCAN skips
    if (t.symbol === 'SCAN' && t.status === 'SKIPPED') return false;
    return true;
  });

  // Auto-Recovery - Clean wipe if core state is corrupted
  useEffect(() => {
    if (isDataBroken) {
        addLog("CRITICAL: PORTFOLIO DATA OVERFLOW DETECTED. PURGING CORRUPT POSITIONS.", 'warning');
        resetAccount();
    }
  }, [isDataBroken]);

  const showInitialLoading = loading && data.length === 0;
  const visibleSignalTableLimit = 30;
  const nearMissSignalThreshold = 1.15;
  const nearMissPicks = React.useMemo(() => {
    return marketPicks
      .filter((pick) => pick.signal.overall === 'HOLD')
      .map((pick) => ({
        pick,
        signalDistance: Math.min(
          Math.abs((pick.signal.score || 0) - 7.2),
          Math.abs((pick.signal.score || 0) - 2.8),
        ),
      }))
      .filter(({ signalDistance }) => signalDistance <= nearMissSignalThreshold)
      .sort((a, b) => {
        if (a.signalDistance !== b.signalDistance) return a.signalDistance - b.signalDistance;
        if ((b.pick.signal.macdScore || 0) !== (a.pick.signal.macdScore || 0)) {
          return (b.pick.signal.macdScore || 0) - (a.pick.signal.macdScore || 0);
        }
        return (b.pick.priorityRank || 0) - (a.pick.priorityRank || 0);
      })
      .slice(0, 6);
  }, [marketPicks]);
  const rejectReasonSummary = React.useMemo(() => {
    const counts = new Map<string, number>();

    for (const pick of marketPicks) {
      if (pick.signal.overall !== 'HOLD') continue;
      const reasons = pick.signal.rejectReasons || [];
      for (const reason of reasons) {
        counts.set(reason, (counts.get(reason) || 0) + 1);
      }
    }

    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([reason, count]) => ({ reason, count }));
  }, [marketPicks]);
  const visibleSignalTablePicks = marketPicks
    .slice(0, visibleSignalTableLimit);

  return (
    <div className="min-h-screen bg-[#E4E3E0] text-[#141414] p-4 md:p-8 font-sans selection:bg-[#F27D26] selection:text-white overflow-x-hidden">

      {/* Fixed overlay toast — always visible regardless of scroll position */}
      {executionFeedback && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-xl w-full px-5 py-3 shadow-2xl border-2 text-[11px] font-mono uppercase tracking-wider flex items-start justify-between gap-4 ${
          executionFeedback.type === 'success'
            ? 'bg-emerald-900 border-emerald-400 text-emerald-100'
            : executionFeedback.type === 'warning'
              ? 'bg-amber-900 border-amber-400 text-amber-100'
              : 'bg-sky-900 border-sky-400 text-sky-100'
        }`}>
          <span className="leading-relaxed">{executionFeedback.message}</span>
          <button onClick={() => setExecutionFeedback(null)} className="shrink-0 font-black opacity-60 hover:opacity-100 text-xs">✕</button>
        </div>
      )}

      {isAuthDisabledBannerVisible && (
        <div className="max-w-7xl mx-auto mb-4 border-2 border-rose-700 bg-rose-50 px-4 py-3 shadow-[6px_6px_0px_0px_#881337]">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <ShieldAlert size={16} className="text-rose-700 mt-0.5 shrink-0" />
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-rose-900">Live trading disabled until {entryLockRetryTime}</p>
              </div>
            </div>
            <span className="text-[10px] font-mono font-black text-rose-800 border border-rose-300 bg-white px-2 py-1 rounded-sm shrink-0">{entryLockRetryTime}</span>
          </div>
        </div>
      )}

      {isAuthDegradedBannerVisible && (
        <div className="max-w-7xl mx-auto mb-4 border-2 border-amber-700 bg-amber-50 px-4 py-3 shadow-[6px_6px_0px_0px_#92400e]">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <ShieldAlert size={16} className="text-amber-700 mt-0.5 shrink-0" />
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-amber-900">Live futures auth degraded</p>
                <p className="text-[10px] font-mono text-amber-900 mt-1">{authDegradedMessage}</p>
              </div>
            </div>
            <span className="text-[10px] font-mono font-black text-amber-800 border border-amber-300 bg-white px-2 py-1 rounded-sm shrink-0">-2015</span>
          </div>
        </div>
      )}

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
                  className={`w-32 px-4 py-1.5 text-[10px] font-black uppercase tracking-tighter transition-all ${!isRealMode ? 'bg-[#F27D26] text-white shadow-lg' : 'text-white/40 hover:text-white'}`}
                >
                  Paper Trading
                </button>
                <button 
                  onClick={async () => {
                    reportSyncError(null);
                    if (entryLockActive) {
                      const lockMessage = `Live trading disabled until ${entryLockRetryTime}`;
                      setExecutionFeedback({ type: 'warning', message: lockMessage });
                      addLog(lockMessage, 'warning');
                      return;
                    }
                    if (serverConfig?.hasKeys) {
                      const success = await syncRealBalance();
                      if (success) setIsRealMode(true);
                    }
                    else {
                      const message = serverStatus !== 'OK'
                        ? 'SERVER STATUS UNKNOWN: wait for connection health before enabling Live Futures.'
                        : 'API KEYS REQUIRED: configure exchange credentials before enabling Live Futures.';
                      reportSyncError(message);
                      setExecutionFeedback({ type: 'warning', message });
                      addLog(message, 'warning');
                    }
                  }}
                  disabled={isSyncing || entryLockActive}
                  className={`w-32 px-4 py-1.5 text-[10px] font-black uppercase tracking-tighter transition-all flex items-center justify-center gap-2 ${isRealMode ? 'bg-rose-600 text-white shadow-lg' : 'text-white/40 hover:text-white'} ${(isSyncing || entryLockActive) ? 'cursor-not-allowed opacity-70' : ''}`}
                >
                  <span className="inline-flex w-3 h-3 items-center justify-center">
                    <Loader2 size={10} className={isSyncing ? 'opacity-60' : 'opacity-0'} />
                  </span>
                  Live Futures
                </button>
                {entryLockActive && (
                  <span className="text-[10px] font-mono uppercase text-rose-600 ml-1">
                    Disabled until {entryLockRemainingSec}s
                  </span>
                )}
             </div>

             <div className="h-6 w-px bg-[#141414]/10 mx-1" />

             <div className="flex items-center gap-2 bg-[#141414]/5 px-3 py-1 rounded-sm border border-[#141414]/10 shadow-sm">
                <div className="flex items-center gap-1.5">
                  <Zap size={10} className={autoTrade ? 'text-emerald-500 fill-emerald-500' : 'text-gray-400'} />
                  <span className="text-[11px] font-black uppercase tracking-tighter opacity-60">Autonomous</span>
                </div>
                <button 
                  onClick={() => {
                    if (!autoTrade && entryLockActive) {
                      const lockMessage = `AUTONOMOUS DISABLED BY SAFETY LOCK: retry in ~${entryLockRemainingSec}s.`;
                      setExecutionFeedback({ type: 'warning', message: lockMessage });
                      addLog(lockMessage, 'warning');
                      return;
                    }
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
                  {!autoTrade && entryLockActive && (
                    <span className="text-[10px] font-mono uppercase text-rose-600">
                      Disabled by Safety Lock ({entryLockRemainingSec}s)
                    </span>
                  )}
             </div>

             <div className="flex items-center bg-white border border-[#141414] rounded-sm overflow-hidden">
                <button 
                  onClick={() => setActiveTab('LIVE')}
                  className={`px-3 py-1 text-[11px] font-black uppercase tracking-tighter transition-colors ${activeTab === 'LIVE' ? 'bg-[#141414] text-white' : 'hover:bg-gray-100 flex items-center gap-1'}`}
                >
                  <Activity size={10} className={isRealMode ? 'text-rose-500' : 'text-[#F27D26]'} />
                  Terminal
                </button>
                <button 
                  onClick={() => setActiveTab('BACKTEST')}
                  className={`px-3 py-1 text-[11px] font-black uppercase tracking-tighter transition-colors ${activeTab === 'BACKTEST' ? 'bg-[#141414] text-white' : 'hover:bg-gray-100 flex items-center gap-1'}`}
                >
                  <History size={10} className="text-blue-500" />
                  Strategy Lab
                </button>
             </div>

             {isRealMode && !serverConfig?.realTradingEnabled && (
               <span className="text-[11px] font-black text-rose-600 bg-rose-50 px-2 py-0.5 border border-rose-200">READ-ONLY MODE</span>
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
                <h2 className="font-mono text-[13px] uppercase tracking-[0.24em] flex items-center gap-2">
                  <Search size={16} className="text-[#F27D26]" />
                  Market Protocol
                </h2>
                <span className="text-[11px] font-mono mt-1 uppercase opacity-50">
                  {scanning
                    ? (isScanPreparing
                      ? `Scanner Active: Preparing ${scanDisplayTotal} Assets`
                      : `Scanner Active: ${scanProgress.current} / ${scanProgress.total} Assets`)
                    : `Scanner Online: Monitoring ${availableSymbols.length} Assets`}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono opacity-50">{scanning ? 'Scanning now' : 'Auto scan ready'}</span>
                <button 
                  onClick={() => performScan(true)} 
                  className="cursor-pointer"
                  disabled={scanning}
                >
                  <Zap size={14} className="text-[#F27D26]" />
                </button>
              </div>
            </div>

            <div className="mt-3 mb-4">
              <div className="flex justify-between text-[11px] font-mono uppercase opacity-60 mb-1">
                <span>{scanning ? 'Scan Progress' : 'Idle'}</span>
                <span>{scanning ? (isScanPreparing ? `Preparing scan...` : `${scanProgress.current}/${scanProgress.total} scanned (${Math.round(scanProgressPct)}%)`) : `${availableSymbols.length} assets`}</span>
              </div>
              <div className="h-1 w-full bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#F27D26]"
                  style={{ width: scanning ? `${isScanPreparing ? 8 : scanProgressPct}%` : `${Math.min(100, Math.max(0, availableSymbols.length > 0 ? 100 : 0))}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2 text-[10px] font-mono uppercase">
              <div className="border border-gray-200 px-2 py-1">
                <span className="opacity-50">Attempted</span>
                <p className="font-black text-[14px]">{scanExecutionStats.attempted}</p>
                <p className="text-[9px] opacity-50">Total {scanExecutionTotals.attempted}</p>
              </div>
              <div className="border border-emerald-200 bg-emerald-50/50 px-2 py-1">
                <span className="opacity-50">Filled</span>
                <p className="font-black text-[14px] text-emerald-700">{scanExecutionStats.filled}</p>
                <p className="text-[9px] opacity-50">Total {scanExecutionTotals.filled}</p>
              </div>
              <div className="border border-rose-200 bg-rose-50/50 px-2 py-1">
                <span className="opacity-50">Failed</span>
                <p className="font-black text-[14px] text-rose-700">{scanExecutionStats.failed}</p>
                <p className="text-[9px] opacity-50">Total {scanExecutionTotals.failed}</p>
              </div>
              <div className="border border-amber-200 bg-amber-50/50 px-2 py-1">
                <span className="opacity-50">Skipped</span>
                <p className="font-black text-[14px] text-amber-700">{scanExecutionStats.skipped}</p>
                <p className="text-[9px] opacity-50">Total {scanExecutionTotals.skipped}</p>
              </div>
            </div>

            <p className="mt-2 text-[10px] font-mono uppercase tracking-wide text-gray-500">{scanStatusHint}</p>
            <p className="mt-1 text-[10px] font-mono uppercase tracking-wide text-gray-500">{scanSourceHint}</p>
            <p className="mt-1 text-[10px] font-mono uppercase tracking-wide text-gray-500">{scanUniverseHint}</p>
            <p className="mt-1 text-[10px] font-mono uppercase tracking-wide text-gray-500">{scanCoverageHint}</p>
            {filteredSyncNote && (
              <div className="mt-2 border border-amber-200 bg-amber-50/80 px-3 py-2 text-[10px] font-mono text-amber-900">
                {filteredSyncNote}
              </div>
            )}

            <div className="mt-2 grid grid-cols-4 gap-2 text-[10px] font-mono uppercase">
              <div className="border border-sky-200 bg-sky-50/60 px-2 py-1">
                <span className="opacity-50">Signals Found</span>
                <p className="font-black text-[14px] text-sky-700">{marketPickLifecycleSummary.signalFound}</p>
              </div>
              <div className="border border-amber-200 bg-amber-50/60 px-2 py-1">
                <span className="opacity-50">Submitted</span>
                <p className="font-black text-[14px] text-amber-700">{marketPickLifecycleSummary.orderSubmitted}</p>
              </div>
              <div className="border border-emerald-200 bg-emerald-50/60 px-2 py-1">
                <span className="opacity-50">Confirmed</span>
                <p className="font-black text-[14px] text-emerald-700">{marketPickLifecycleSummary.exchangeConfirmed}</p>
              </div>
              <div className="border border-[#F27D26]/30 bg-[#F27D26]/10 px-2 py-1">
                <span className="opacity-50">Open Positions</span>
                <p className="font-black text-[14px] text-[#C85E13]">{marketPickLifecycleSummary.openPositions}</p>
              </div>
            </div>

            <div className="mt-3 border border-indigo-200 bg-indigo-50/60 px-3 py-2 text-[10px] font-mono uppercase">
              <div className="flex items-center justify-between text-indigo-900/70">
                <span>Last Scan Summary</span>
                <span>{scanSignalSummary.updatedAt ? new Date(scanSignalSummary.updatedAt).toLocaleTimeString() : '--:--:--'}</span>
              </div>
              <div className="mt-2 grid grid-cols-4 gap-2">
                <div className="border border-indigo-200 bg-white/60 px-2 py-1">
                  <span className="opacity-50">Analyzed</span>
                  <p className="font-black text-[13px] text-indigo-800">{scanSignalSummary.analyzed}/{scanSignalSummary.total}</p>
                </div>
                <div className="border border-emerald-200 bg-emerald-50/70 px-2 py-1">
                  <span className="opacity-50">BUY</span>
                  <p className="font-black text-[13px] text-emerald-700">{scanSignalSummary.buy}</p>
                </div>
                <div className="border border-rose-200 bg-rose-50/70 px-2 py-1">
                  <span className="opacity-50">SELL</span>
                  <p className="font-black text-[13px] text-rose-700">{scanSignalSummary.sell}</p>
                </div>
                <div className="border border-gray-200 bg-gray-50/70 px-2 py-1">
                  <span className="opacity-50">HOLD</span>
                  <p className="font-black text-[13px] text-gray-700">{scanSignalSummary.hold}</p>
                </div>
              </div>
            </div>

            <div className="mt-3 border border-gray-300 bg-gray-50/80 px-3 py-2 text-[10px] font-mono uppercase">
              <div className="flex items-center justify-between text-gray-800/80">
                <span>Why Coins Were Rejected</span>
                <span>{rejectReasonSummary.length > 0 ? `${rejectReasonSummary.length} dominant causes` : 'No rejection data yet'}</span>
              </div>
              {rejectReasonSummary.length === 0 ? (
                <p className="mt-2 text-[10px] normal-case tracking-normal text-gray-700/70">
                  No aggregated HOLD rejection reasons are available yet for this session.
                </p>
              ) : (
                <div className="mt-2 space-y-2">
                  {rejectReasonSummary.map(({ reason, count }) => (
                    <div key={`reject-reason-${reason}`} className="border border-gray-200 bg-white/70 px-2 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[9px] normal-case tracking-normal text-gray-900">{reason}</span>
                        <span className="font-black text-[11px] text-gray-700">{count}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-3 border border-rose-200 bg-rose-50/60 px-3 py-2 text-[10px] font-mono uppercase">
              <div className="flex items-center justify-between text-rose-900/80">
                <span>Top Blocked Signals</span>
                <span>{scanBlockedSummary.filteredSignals > 0 ? `${scanBlockedSummary.filteredSignals} filtered` : 'No blocked signals'}</span>
              </div>
              {scanBlockedSummary.filteredSignals > 0 && (
                <p className="mt-1 text-[9px] normal-case tracking-normal text-rose-900/70">
                  {Object.entries(scanBlockedSummary.reasonCounts)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 3)
                    .map(([reason, count]) => `${count} ${reason}`)
                    .join(' | ')}
                </p>
              )}
              {scanBlockedSummary.topBlocked.length === 0 ? (
                <p className="mt-2 text-[10px] normal-case tracking-normal text-rose-900/70">
                  No strong signals were excluded by holdings, cooldowns, or live-market safety filters in the last scan.
                </p>
              ) : (
                <div className="mt-2 space-y-2">
                  {scanBlockedSummary.topBlocked.map((entry) => (
                    <div key={`blocked-${entry.symbol}-${entry.reason}`} className="border border-rose-200 bg-white/60 px-2 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-black text-[11px] text-rose-950">{entry.symbol}</span>
                        <span className="text-[9px] text-rose-900/70">{entry.side} | score {entry.score.toFixed(1)} | rank {entry.priorityRank.toFixed(2)}</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[9px] text-rose-900/75">
                        <span>{entry.reason}</span>
                        <span>excluded pre-entry</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-3 border border-sky-200 bg-sky-50/60 px-3 py-2 text-[10px] font-mono uppercase">
              <div className="flex items-center justify-between text-sky-900/80">
                <span>Deferred By Throttle</span>
                <span>{scanDeferredSummary.deferredSignals > 0 ? `${scanDeferredSummary.deferredSignals} postponed` : 'No deferred entries'}</span>
              </div>
              {scanDeferredSummary.topDeferred.length === 0 ? (
                <p className="mt-2 text-[10px] normal-case tracking-normal text-sky-900/70">
                  No eligible signals were postponed by the live per-cycle entry throttle in the last scan.
                </p>
              ) : (
                <div className="mt-2 space-y-2">
                  {scanDeferredSummary.topDeferred.map((entry) => (
                    <div key={`deferred-${entry.symbol}-${entry.side}`} className="border border-sky-200 bg-white/60 px-2 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-black text-[11px] text-sky-950">{entry.symbol}</span>
                        <span className="text-[9px] text-sky-900/70">{entry.side} | score {entry.score.toFixed(1)} | rank {entry.priorityRank.toFixed(2)}</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[9px] text-sky-900/75">
                        <span>eligible but postponed by live cycle throttle</span>
                        <span>next cycle candidate</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-3 border border-amber-200 bg-amber-50/60 px-3 py-2 text-[10px] font-mono uppercase">
              <div className="flex items-center justify-between text-amber-900/80">
                <span>Top Near Misses</span>
                <span>{nearMissPicks.length > 0 ? `${nearMissPicks.length} close HOLDs` : 'No near misses'}</span>
              </div>
              {nearMissPicks.length === 0 ? (
                <p className="mt-2 text-[10px] normal-case tracking-normal text-amber-900/70">
                  No HOLD setups are currently close enough to the BUY/SELL thresholds to qualify as near misses.
                </p>
              ) : (
                <div className="mt-2 space-y-2">
                  {nearMissPicks.map(({ pick, signalDistance }) => (
                    <div key={`near-miss-${pick.symbol}`} className="border border-amber-200 bg-white/60 px-2 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-black text-[11px] text-amber-950">{pick.symbol}</span>
                        <span className="text-[9px] text-amber-900/70">score {pick.signal.score.toFixed(1)} | rank {(pick.priorityRank || 0).toFixed(2)} | MACD {pick.signal.macdScore.toFixed(1)}</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[9px] text-amber-900/75">
                        <span>{describeHoldReason(pick.signal.holdReason)}</span>
                        <span>{signalDistance.toFixed(2)} from trigger</span>
                      </div>
                      {pick.signal.rejectReasons && pick.signal.rejectReasons.length > 0 && (
                        <p className="mt-1 text-[9px] normal-case tracking-normal text-amber-900/70">
                          {summarizeRejectReasons(pick.signal.rejectReasons, 3)}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="bg-white border-2 border-[#141414] p-4 shadow-[8px_8px_0px_0px_#141414]">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-mono text-[12px] uppercase tracking-[0.2em] opacity-75">Top Ranked Signals</h3>
                <span className="text-[10px] font-mono uppercase opacity-50">{visibleSignalTablePicks.length} shown</span>
              </div>
              <p className="text-[9px] font-mono uppercase tracking-wide opacity-45 px-2">
                Displaying strategy score and profitability rank side by side.
              </p>
              <div className="grid grid-cols-5 items-center border-b pb-2 text-[10px] font-mono opacity-50 uppercase tracking-wide px-2">
                <span>Asset</span>
                <span className="text-center">Trend/RSI</span>
                <span className="text-center">Score / Rank</span>
                <span className="text-center">Signal</span>
                <span className="text-right">Action</span>
              </div>
              <div className="space-y-2 max-h-[520px] overflow-y-auto custom-scrollbar pr-2">
                {visibleSignalTablePicks.map((pick) => {
                  const lifecycle = getMarketPickLifecycle(pick);
                  return (
                  <div key={pick.symbol} className="grid grid-cols-5 items-center group py-1.5 hover:bg-gray-50/50 px-2 border-b border-gray-50 transition-colors">
                    <button 
                      onClick={() => setSymbol(pick.symbol)}
                      className="flex flex-col items-start text-left text-[13px] font-black hover:text-[#F27D26] transition-colors"
                    >
                      <span>{pick.symbol.replace('USDT', '')}</span>
                      <span className={`mt-1 rounded-sm px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide ${lifecycle.className}`}>
                        {lifecycle.label}
                      </span>
                    </button>
                    
                    <div className="text-center flex flex-col">
                      <div className="flex items-center justify-center gap-1">
                         <span className={`text-[11px] font-mono font-bold ${pick.trend === 'UP' ? 'text-emerald-600' : 'text-rose-600'}`}>
                           {pick.trend}
                         </span>
                         <span className="text-[9px] font-mono opacity-40">@{pick.rsi?.toFixed(0)}</span>
                      </div>
                    </div>

                    <div className="text-center">
                      <div className="flex flex-col items-center leading-tight">
                        <span className={`text-[11px] font-mono font-bold ${
                          pick.signal.score >= 8 ? 'text-emerald-500' :
                          pick.signal.score >= 5 ? 'text-[#F27D26]' :
                          'opacity-30'
                        }`}>
                          {pick.signal.score}/10
                        </span>
                        <span className="text-[8px] font-mono uppercase opacity-45">
                          rank {(pick.priorityRank || 0).toFixed(2)}
                        </span>
                      </div>
                    </div>

                    <div className="flex justify-center">
                      <div className="flex flex-col items-center gap-1">
                        <div className={`text-[10px] font-black px-1 rounded-sm ${
                          pick.signal.overall === 'BUY' ? 'bg-emerald-100 text-emerald-800' : 
                          pick.signal.overall === 'SELL' ? 'bg-rose-100 text-rose-800' : 'bg-gray-100 text-gray-400'
                        }`}>
                          {pick.signal.overall}
                        </div>
                        {pick.signal.overall === 'HOLD' && pick.signal.holdReason && (
                          <div className="max-w-[140px] text-center leading-tight">
                            <span className="text-[8px] font-mono uppercase text-amber-700 opacity-80">
                              {describeHoldReason(pick.signal.holdReason)}
                            </span>
                            {pick.signal.rejectReasons && pick.signal.rejectReasons.length > 0 && (
                              <span className="mt-1 block text-[8px] normal-case font-mono text-amber-700/75">
                                {summarizeRejectReasons(pick.signal.rejectReasons)}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex justify-end">
                      <button 
                        onClick={() => executeTrade(pick.signal.overall === 'SELL' ? 'SELL' : 'BUY', pick.symbol, pick.lastPrice, `AI_${pick.signal.overall}_DISCOVERY_${pick.signal.score}`)}
                        disabled={pick.signal.overall === 'HOLD' || entryLockActive || holdings.length >= maxConcurrentTrades || holdings.some(h => h.symbol === pick.symbol)}
                        className="text-[#141414] hover:bg-[#F27D26] hover:text-white border border-[#141414]/10 text-[10px] px-2 py-0.5 font-bold uppercase transition-all disabled:opacity-0"
                      >
                        {pick.signal.overall === 'SELL' ? 'Short' : pick.signal.overall === 'BUY' ? 'Long' : 'Hold'}
                      </button>
                    </div>
                  </div>
                )})}
              </div>
            </div>
          </section>

          {/* Risk Management Card */}
          <section className="bg-[#141414] text-[#E4E3E0] p-6 rounded-sm shadow-xl relative overflow-hidden">
             <div className="absolute top-0 right-0 p-2 opacity-5">
              <ShieldAlert size={120} strokeWidth={1} />
            </div>
            
            <h2 className="font-mono text-[12px] uppercase tracking-[0.3em] mb-6 flex items-center gap-2 border-b border-white/10 pb-2">
              Risk Guard
            </h2>

              <div className="space-y-6 relative z-10">
                <div>
                  <label className="text-[12px] uppercase font-bold opacity-60 mb-1 block">Laboratory Seed Capital</label>
                  <div className="flex gap-2">
                    <input 
                      type="number" 
                      value={seedCapital}
                      onChange={(e) => setSeedCapital(parseFloat(e.target.value) || 0)}
                      className="bg-white/10 border border-white/20 rounded-sm py-1 px-3 text-sm font-mono w-full focus:outline-none focus:border-[#F27D26]"
                    />
                    <button 
                      onClick={resetAccount}
                      className="text-[12px] font-bold bg-[#F27D26] px-3 py-1 rounded-sm text-white hover:bg-orange-600 transition-colors"
                    >
                      SET
                    </button>
                  </div>
                  <p className="text-[9px] font-mono opacity-30 mt-1">Changes balance only on SET/RESET.</p>
                </div>

                <div>
                  <label className="text-[12px] uppercase font-bold opacity-60 mb-1 block">Capital Concentration</label>
                  <input 
                    type="range" 
                    min="1" 
                    max="30" 
                    step="1" 
                    value={maxConcurrentTrades}
                    onChange={(e) => setMaxConcurrentTrades(parseInt(e.target.value))}
                    className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-[#F27D26]"
                  />
                  <div className="flex justify-between font-mono text-[10px] mt-1 opacity-40">
                    <span>Targeted ($$$)</span>
                    <span className="text-[#F27D26] font-bold opacity-100">{maxConcurrentTrades} SLOTS</span>
                    <span>Broad ($)</span>
                  </div>
                </div>

                <div>
                  <label className="text-[12px] uppercase font-bold opacity-60 mb-1 block text-emerald-400">Take Profit (Policy: 15%)</label>
                  <input 
                    type="range" 
                    min="1" 
                    max="20" 
                    step="1" 
                    value={takeProfitPercent}
                    onChange={(e) => setTakeProfitPercent(parseFloat(e.target.value))}
                    className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                  />
                  <div className="flex justify-between font-mono text-[10px] mt-1 opacity-40">
                    <span>Scalp (1%)</span>
                    <span className="text-emerald-400 font-bold opacity-100">{takeProfitPercent}% TARGET</span>
                    <span>Swing (20%)</span>
                  </div>
                </div>

                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="text-[12px] uppercase font-bold opacity-60 text-rose-400">Standard Stop Loss</label>
                    <div className="flex gap-1 items-center bg-white/5 border border-white/10 px-1 rounded-sm">
                       <input 
                         type="number" 
                         value={stopLossPercent}
                         onChange={(e) => setStopLossPercent(parseFloat(e.target.value) || 0)}
                         className="w-10 bg-transparent text-[12px] font-mono text-center focus:outline-none"
                         step="0.1"
                       />
                       <span className="text-[10px] opacity-40">%</span>
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
                  <div className="flex justify-between font-mono text-[10px] mt-1 opacity-40">
                    <span>Defensive (0.2%)</span>
                    <span className="text-rose-400 font-bold opacity-100">{stopLossPercent}% GUARD</span>
                    <span>Broad (10%)</span>
                  </div>
                </div>

                <div className="p-3 bg-red-950/20 border border-red-500/20 rounded-sm">
                  <div className="flex justify-between items-center mb-2">
                    <div className="flex flex-col">
                      <label className="text-[12px] uppercase font-bold text-rose-300">Portfolio Emergency Shield</label>
                      <span className="text-[9px] opacity-40 uppercase">Liquidation on Drawdown</span>
                    </div>
                    <div className="flex gap-1 items-center bg-black/40 border border-white/10 px-1 rounded-sm">
                       <input 
                         type="number" 
                         value={maxDrawdownPercent}
                         onChange={(e) => setMaxDrawdownPercent(parseFloat(e.target.value) || 0)}
                         className="w-10 bg-transparent text-[12px] font-mono text-center text-rose-300 focus:outline-none"
                         step="1"
                       />
                       <span className="text-[10px] opacity-40">%</span>
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
                  <div className="flex justify-between font-mono text-[10px] mt-1 opacity-40">
                    <span>Ultra-Tight (1%)</span>
                    <span className="text-rose-300 font-bold">{maxDrawdownPercent}% MAX DRAWDOWN</span>
                    <span>Loose (30%)</span>
                  </div>
                </div>

                <div className="flex items-center justify-between p-2 bg-emerald-500/10 border border-emerald-500/20 rounded-sm">
                   <div className="flex flex-col">
                      <div className="flex items-center gap-1">
                        <ShieldCheck size={14} className="text-emerald-400" />
                        <span className="text-[12px] uppercase font-black text-emerald-400">Adaptive Defense</span>
                      </div>
                      <span className="text-[9px] opacity-40 leading-tight">HALVES POSITIONS SIZE ON VOLATILITY</span>
                   </div>
                   <button 
                    onClick={() => setIsDefensiveMode(!isDefensiveMode)}
                    className={`px-3 py-1 rounded-xs text-[12px] font-black transition-all ${isDefensiveMode ? 'bg-emerald-500 text-black' : 'bg-white/10 text-white hover:bg-white/20'}`}
                   >
                     {isDefensiveMode ? 'ACTIVE' : 'OFF'}
                   </button>
                </div>

                <div className="p-3 bg-white/5 border border-white/10 rounded-sm space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[12px] uppercase font-bold opacity-70">Strategy Criteria</p>
                    <button
                      type="button"
                      onClick={resetParametersToDefaults}
                      className="rounded-sm border border-rose-300/40 bg-rose-500/10 px-3 py-1.5 text-[11px] font-black uppercase tracking-wide text-rose-200 hover:bg-rose-500/20"
                    >
                      Reset to Defaults
                    </button>
                  </div>
                  <div className="flex items-center justify-between rounded-sm border border-white/10 bg-black/25 px-3 py-2">
                    <span className="text-[12px] uppercase tracking-wide text-white/70">Important Items</span>
                    <button
                      type="button"
                      onClick={() => setShowExtraCriteria(prev => !prev)}
                      className="rounded-sm border border-cyan-400/40 bg-cyan-500/15 px-3 py-1.5 text-[12px] font-black uppercase tracking-wide text-cyan-200 hover:bg-cyan-500/30"
                    >
                      {showExtraCriteria ? 'Hide Extra Items' : 'Show Extra Items'}
                    </button>
                  </div>
                  <div className="flex items-center justify-between rounded-sm border border-amber-300/40 bg-amber-500/10 px-3 py-2">
                    <div className="flex flex-col">
                      <span className="text-[12px] uppercase tracking-wide text-amber-200">Full Universe Mode</span>
                      <span className="text-[10px] text-amber-100/70">Scans spot + futures across all quote assets and ignores Max Symbols / Scan. Slower, much higher rate-limit risk.</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setFullUniverseMode(!fullUniverseMode)}
                      className={`rounded-sm border px-3 py-1.5 text-[12px] font-black uppercase tracking-wide transition-colors ${fullUniverseMode ? 'border-amber-300 bg-amber-400/30 text-amber-100' : 'border-white/20 bg-white/5 text-white/60 hover:bg-white/10'}`}
                    >
                      {fullUniverseMode ? 'ON' : 'OFF'}
                    </button>
                  </div>
                  {!showExtraCriteria && (
                    <p className="text-[11px] uppercase tracking-wide text-white/45">
                      Showing core controls only. Enable extra items for advanced tuning.
                    </p>
                  )}
                  <div className="space-y-2 rounded-sm border border-cyan-500/20 bg-cyan-500/5 p-2">
                    <p className="text-[8px] uppercase font-bold tracking-wide text-cyan-300">AI Criteria Editor</p>
                    <textarea
                      value={aiCriteriaPrompt}
                      onChange={(e) => setAiCriteriaPrompt(e.target.value)}
                      placeholder="Example: set scan interval 60, holding poll 8, max symbols 50, rsi overbought 72"
                      className="h-16 w-full resize-none rounded-sm border border-white/10 bg-black/40 px-2 py-1 text-[10px] font-mono"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={applyAiCriteriaPrompt}
                        className="rounded-xs border border-cyan-400/40 bg-cyan-500/20 px-2 py-1 text-[9px] font-black uppercase tracking-wide text-cyan-200 hover:bg-cyan-500/30"
                      >
                        Apply AI Command
                      </button>
                      <button
                        type="button"
                        onClick={restoreAiCriteriaSnapshot}
                        disabled={!aiCriteriaSnapshot}
                        className={`rounded-xs border px-2 py-1 text-[9px] font-black uppercase tracking-wide transition-colors ${
                          aiCriteriaSnapshot
                            ? 'border-amber-300/60 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
                            : 'border-white/20 bg-white/5 text-white/40 cursor-not-allowed'
                        }`}
                      >
                        Reset to Previous
                      </button>
                      {aiCriteriaFeedback && <span className="text-[10px] text-cyan-200/80">{aiCriteriaFeedback}</span>}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Auto Entry Score" detail={CRITERIA_HELP.autoEntryMinScore} />
                      <input type="number" min="0" max="10" step="0.5" value={autoEntryMinScore} onChange={(e) => setAutoEntryMinScore(parseFloat(e.target.value) || 0)} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Min Live Notional" detail={CRITERIA_HELP.liveMinOrderNotional} />
                      <input type="number" min="1" step="1" value={liveMinOrderNotional} onChange={(e) => setLiveMinOrderNotional(parseFloat(e.target.value) || 1)} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="MACD Fast" detail={CRITERIA_HELP.macdFastPeriod} />
                      <input type="number" min="1" step="1" value={strategyConfig.macdFastPeriod} onChange={(e) => updateStrategyConfig({ macdFastPeriod: Math.max(1, parseInt(e.target.value, 10) || 1) })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="MACD Slow" detail={CRITERIA_HELP.macdSlowPeriod} />
                      <input type="number" min="2" step="1" value={strategyConfig.macdSlowPeriod} onChange={(e) => updateStrategyConfig({ macdSlowPeriod: Math.max(2, parseInt(e.target.value, 10) || 2) })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="MACD Signal" detail={CRITERIA_HELP.macdSignalPeriod} />
                      <input type="number" min="1" step="1" value={strategyConfig.macdSignalPeriod} onChange={(e) => updateStrategyConfig({ macdSignalPeriod: Math.max(1, parseInt(e.target.value, 10) || 1) })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Continuation Score" detail={CRITERIA_HELP.continuationScore} />
                      <input type="number" min="0" max="10" step="0.5" value={strategyConfig.continuationScore} onChange={(e) => updateStrategyConfig({ continuationScore: parseFloat(e.target.value) || 0 })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="RSI Overbought" detail={CRITERIA_HELP.rsiOverbought} />
                      <input type="number" min="50" max="95" step="1" value={strategyConfig.rsiOverbought} onChange={(e) => updateStrategyConfig({ rsiOverbought: parseFloat(e.target.value) || 70 })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="RSI Oversold" detail={CRITERIA_HELP.rsiOversold} />
                      <input type="number" min="5" max="50" step="1" value={strategyConfig.rsiOversold} onChange={(e) => updateStrategyConfig({ rsiOversold: parseFloat(e.target.value) || 45 })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Scan Interval (s)" detail={CRITERIA_HELP.scanIntervalSec} />
                      <input type="number" min="10" step="1" value={scanIntervalSec} onChange={(e) => setScanIntervalSec(Math.max(10, parseInt(e.target.value, 10) || 10))} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Holding Poll (s)" detail={CRITERIA_HELP.holdingPollIntervalSec} />
                      <input type="number" min="10" step="1" value={holdingPollIntervalSec} onChange={(e) => setHoldingPollIntervalSec(Math.max(10, parseInt(e.target.value, 10) || 10))} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Max Symbols / Scan" detail={CRITERIA_HELP.maxSymbolsPerScan} />
                      <input type="number" min="20" max={SCAN_SHORTLIST_SAFE_CAP} step="10" value={maxSymbolsPerScan} onChange={(e) => setMaxSymbolsPerScan(Math.max(20, Math.min(SCAN_SHORTLIST_SAFE_CAP, parseInt(e.target.value, 10) || 20)))} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Soft Cooldown (m)" detail={CRITERIA_HELP.softCooldownMinutes} />
                      <input type="number" min="1" step="1" value={softCooldownMinutes} onChange={(e) => setSoftCooldownMinutes(Math.max(1, parseInt(e.target.value, 10) || 1))} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Success Cooldown (m)" detail={CRITERIA_HELP.successCooldownMinutes} />
                      <input type="number" min="1" step="1" value={successCooldownMinutes} onChange={(e) => setSuccessCooldownMinutes(Math.max(1, parseInt(e.target.value, 10) || 1))} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Paper Loss Cooldown (m)" detail={CRITERIA_HELP.paperLossCooldownMinutes} />
                      <input type="number" min="1" step="1" value={paperLossCooldownMinutes} onChange={(e) => setPaperLossCooldownMinutes(Math.max(1, parseInt(e.target.value, 10) || 1))} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Order Lockout (s)" detail={CRITERIA_HELP.duplicateOrderLockoutSec} />
                      <input type="number" min="1" step="1" value={duplicateOrderLockoutSec} onChange={(e) => setDuplicateOrderLockoutSec(Math.max(1, parseInt(e.target.value, 10) || 1))} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Live Entry Delay (ms)" detail={CRITERIA_HELP.liveEntryDelayMs} />
                      <input type="number" min="0" step="50" value={liveEntryDelayMs} onChange={(e) => setLiveEntryDelayMs(Math.max(0, parseInt(e.target.value, 10) || 0))} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Live Entries / Cycle" detail={CRITERIA_HELP.liveEntriesPerCycle} />
                      <input type="number" min="1" step="1" value={liveEntriesPerCycle} onChange={(e) => setLiveEntriesPerCycle(Math.max(1, parseInt(e.target.value, 10) || 1))} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Min Paper Allocation" detail={CRITERIA_HELP.minPaperAllocation} />
                      <input type="number" min="1" step="1" value={minPaperAllocation} onChange={(e) => setMinPaperAllocation(Math.max(1, parseInt(e.target.value, 10) || 1))} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Low Margin Lock (m)" detail={CRITERIA_HELP.lowMarginLockMinutes} />
                      <input type="number" min="1" step="1" value={lowMarginLockMinutes} onChange={(e) => setLowMarginLockMinutes(Math.max(1, parseInt(e.target.value, 10) || 1))} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Close Failure Lock (m)" detail={CRITERIA_HELP.closeFailureLockMinutes} />
                      <input type="number" min="1" step="1" value={closeFailureLockMinutes} onChange={(e) => setCloseFailureLockMinutes(Math.max(1, parseInt(e.target.value, 10) || 1))} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Hard Failure Lock (m)" detail={CRITERIA_HELP.hardFailureLockMinutes} />
                      <input type="number" min="1" step="1" value={hardFailureLockMinutes} onChange={(e) => setHardFailureLockMinutes(Math.max(1, parseInt(e.target.value, 10) || 1))} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    {showExtraCriteria && (
                      <>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Trend SMA Period" detail={CRITERIA_HELP.trendSmaPeriod} />
                      <input type="number" min="2" step="1" value={strategyConfig.trendSmaPeriod} onChange={(e) => updateStrategyConfig({ trendSmaPeriod: Math.max(2, parseInt(e.target.value, 10) || 2) })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="RSI Period" detail={CRITERIA_HELP.rsiPeriod} />
                      <input type="number" min="2" step="1" value={strategyConfig.rsiPeriod} onChange={(e) => updateStrategyConfig({ rsiPeriod: Math.max(2, parseInt(e.target.value, 10) || 2) })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="EMA Fast Period" detail={CRITERIA_HELP.emaFastPeriod} />
                      <input type="number" min="1" step="1" value={strategyConfig.emaFastPeriod} onChange={(e) => updateStrategyConfig({ emaFastPeriod: Math.max(1, parseInt(e.target.value, 10) || 1) })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="EMA Slow Period" detail={CRITERIA_HELP.emaSlowPeriod} />
                      <input type="number" min="2" step="1" value={strategyConfig.emaSlowPeriod} onChange={(e) => updateStrategyConfig({ emaSlowPeriod: Math.max(2, parseInt(e.target.value, 10) || 2) })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Volume Lookback" detail={CRITERIA_HELP.volumeLookback} />
                      <input type="number" min="2" step="1" value={strategyConfig.volumeLookback} onChange={(e) => updateStrategyConfig({ volumeLookback: Math.max(2, parseInt(e.target.value, 10) || 2) })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Volume Multiplier" detail={CRITERIA_HELP.volumeMultiplier} />
                      <input type="number" min="0.1" step="0.1" value={strategyConfig.volumeMultiplier} onChange={(e) => updateStrategyConfig({ volumeMultiplier: Math.max(0.1, parseFloat(e.target.value) || 0.1) })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Support Lookback" detail={CRITERIA_HELP.supportLookback} />
                      <input type="number" min="2" step="1" value={strategyConfig.supportLookback} onChange={(e) => updateStrategyConfig({ supportLookback: Math.max(2, parseInt(e.target.value, 10) || 2) })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Near Support (%)" detail={CRITERIA_HELP.nearSupportPercent} />
                      <input type="number" min="0.1" step="0.1" value={strategyConfig.nearSupportPercent} onChange={(e) => updateStrategyConfig({ nearSupportPercent: Math.max(0.1, parseFloat(e.target.value) || 0.1) })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Near Resistance (%)" detail={CRITERIA_HELP.nearResistancePercent} />
                      <input type="number" min="0.1" step="0.1" value={strategyConfig.nearResistancePercent} onChange={(e) => updateStrategyConfig({ nearResistancePercent: Math.max(0.1, parseFloat(e.target.value) || 0.1) })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Crossover Score" detail={CRITERIA_HELP.crossoverScore} />
                      <input type="number" min="0" max="10" step="0.5" value={strategyConfig.crossoverScore} onChange={(e) => updateStrategyConfig({ crossoverScore: parseFloat(e.target.value) || 0 })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Trend Context Score" detail={CRITERIA_HELP.contextTrendScore} />
                      <input type="number" min="0" max="10" step="0.5" value={strategyConfig.contextTrendScore} onChange={(e) => updateStrategyConfig({ contextTrendScore: parseFloat(e.target.value) || 0 })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Volume Context Score" detail={CRITERIA_HELP.contextVolumeScore} />
                      <input type="number" min="0" max="10" step="0.5" value={strategyConfig.contextVolumeScore} onChange={(e) => updateStrategyConfig({ contextVolumeScore: parseFloat(e.target.value) || 0 })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="MACD Context Score" detail={CRITERIA_HELP.contextMacdScore} />
                      <input type="number" min="0" max="10" step="0.5" value={strategyConfig.contextMacdScore} onChange={(e) => updateStrategyConfig({ contextMacdScore: parseFloat(e.target.value) || 0 })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="EMA Context Score" detail={CRITERIA_HELP.contextEmaScore} />
                      <input type="number" min="0" max="10" step="0.5" value={strategyConfig.contextEmaScore} onChange={(e) => updateStrategyConfig({ contextEmaScore: parseFloat(e.target.value) || 0 })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="RSI Context Score" detail={CRITERIA_HELP.contextRsiScore} />
                      <input type="number" min="0" max="10" step="0.5" value={strategyConfig.contextRsiScore} onChange={(e) => updateStrategyConfig({ contextRsiScore: parseFloat(e.target.value) || 0 })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                    <label className="text-[18px] uppercase opacity-70"><CriteriaInfoLabel text="Max Score" detail={CRITERIA_HELP.maxScore} />
                      <input type="number" min="1" max="10" step="0.5" value={strategyConfig.maxScore} onChange={(e) => updateStrategyConfig({ maxScore: Math.max(1, parseFloat(e.target.value) || 1) })} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                      </>
                    )}
                  </div>
                  {showExtraCriteria && (
                    <label className="text-[18px] uppercase opacity-70 block"><CriteriaInfoLabel text="Allowed Live Quotes (comma separated)" detail={CRITERIA_HELP.liveQuoteAllowlistInput} />
                      <input type="text" value={liveQuoteAllowlistInput} onChange={(e) => setLiveQuoteAllowlistInput(e.target.value.toUpperCase())} className="mt-2 w-full h-12 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-[18px] font-mono" />
                    </label>
                  )}
                </div>

                <div className="pt-4 border-t border-white/10">
                   <div className="flex items-center justify-between mb-4">
                    <div className="flex flex-col">
                      <label className="text-[10px] uppercase font-bold opacity-60">Exchange Node Sync</label>
                      <span className="text-[7px] font-mono opacity-30 uppercase">
                        {isRealMode ? `${(serverConfig?.exchange || 'EXCHANGE').toUpperCase()} ${serverConfig?.type || ''} LINKED` : 'SIMULATION MODE'}
                      </span>
                      {isRealMode && serverConfig?.exchange === 'binance' && serverConfig?.binanceRouteHealth && (
                        <span className="mt-1 text-[7px] font-mono uppercase text-cyan-300/80">
                          Route Health: positions {serverConfig.binanceRouteHealth.positions || 'UNKNOWN'} / orders {serverConfig.binanceRouteHealth.orders || 'UNKNOWN'}
                        </span>
                      )}
                    </div>
                    <button 
                      onClick={async () => {
                        if (isRealMode) setIsRealMode(false);
                        else {
                          const success = await syncRealBalance();
                          if (success) setIsRealMode(true);
                        }
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
                          onClick={dismissSyncError}
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
                      <span className="text-[8px] uppercase font-bold opacity-40">MACD Histogram</span>
                      <span className="text-[10px] font-black uppercase">
                        {describeMacdHistogram(strategy?.confluence.macdHistogram)}
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
                   <div className="flex flex-col items-end gap-1">
                     <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-black px-2 py-0.5 rounded-sm ${
                        strategy?.overall === 'BUY' ? 'bg-emerald-500 text-white' : 
                        strategy?.overall === 'SELL' ? 'bg-rose-500 text-white' : 'bg-white/10 text-white/40'
                      }`}>
                        {strategy?.overall || 'IDLE'}
                      </span>
                     </div>
                     {strategy?.overall === 'HOLD' && strategy.holdReason && (
                       <div className="max-w-[220px] text-right leading-tight text-amber-200/80">
                         <span className="text-[9px] font-mono uppercase">
                           {describeHoldReason(strategy.holdReason)}
                         </span>
                         {strategy.rejectReasons && strategy.rejectReasons.length > 0 && (
                           <span className="mt-1 block text-[9px] normal-case font-mono text-amber-200/70">
                             {summarizeRejectReasons(strategy.rejectReasons, 3)}
                           </span>
                         )}
                       </div>
                     )}
                   </div>
                </div>
             </div>
          </div>

          {/* Metrics Dashboard */}
          {executionFeedback && (
            <section className={`mb-6 border-2 px-4 py-3 text-[10px] font-mono uppercase tracking-wider ${
              executionFeedback.type === 'success'
                ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                : executionFeedback.type === 'warning'
                  ? 'bg-amber-50 border-amber-300 text-amber-800'
                  : 'bg-sky-50 border-sky-300 text-sky-800'
            }`}>
              <div className="flex items-center justify-between gap-3">
                <span>{executionFeedback.message}</span>
                <button
                  onClick={() => setExecutionFeedback(null)}
                  className="text-[9px] font-black opacity-60 hover:opacity-100"
                >
                  DISMISS
                </button>
              </div>
            </section>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            <MetricBox 
              icon={<Wallet className={isRealMode ? 'text-rose-500' : 'text-[#F27D26]'} size={18} />}
              label="Portfolio Value"
              value={`$${equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              trend={pnl >= 0 ? 'up' : 'down'}
              subValue={
                <div className="flex items-center gap-2">
                   <span className="opacity-60">AVAILABLE: ${displayedAvailableFunds.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
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
              label="Current P&L"
              value={`${openPnl >= 0 ? '+' : '-'}$${Math.abs(openPnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              trend={openPnl >= 0 ? 'up' : 'down'}
              subValue="Unrealized (Open Positions)"
            />
            <MetricBox 
              icon={<DollarSign className={isRealMode ? 'text-rose-500' : 'text-[#F27D26]'} size={18} />}
              label="Total P&L"
              value={`${totalPnl >= 0 ? '+' : '-'}$${Math.abs(totalPnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              trend={totalPnl >= 0 ? 'up' : 'down'}
              subValue={`Realized: ${realizedPnl >= 0 ? '+' : '-'}$${Math.abs(realizedPnl).toFixed(2)} | Open: ${openPnl >= 0 ? '+' : '-'}$${Math.abs(openPnl).toFixed(2)}`}
            />
            <MetricBox 
              icon={<Zap className={isRealMode ? 'text-rose-500' : 'text-[#F27D26]'} size={18} />}
              label="Network Status"
              value={isSyncing ? "SYNCING..." : (isRealMode ? "LIVE" : "PAPER")}
              subValue={serverConfig?.exchange
                ? `${serverConfig.exchange.toUpperCase()} | ${holdings.length}/${maxConcurrentTrades} SLOTS${entryLockActive ? ' | ENTRY LOCK' : ''} | ${scanDataSource}`
                : "SIMULATION"}
            />
            <MetricBox 
              icon={<DollarSign className={isRealMode ? 'text-rose-500' : 'text-[#F27D26]'} size={18} />}
              label="Available Margin"
              value={`$${displayedAvailableFunds.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              subValue={isRealMode ? "Live Exchange Free Balance" : "Simulated Capital"}
            />
            <MetricBox 
              icon={<Activity className={isRealMode ? 'text-rose-500' : 'text-[#F27D26]'} size={18} />}
              label="Budget Efficiency"
              value={`${investedPct.toFixed(1)}%`}
              subValue="Used Equity %"
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
                <thead className="bg-gray-50 border-b-2 border-gray-100 uppercase font-mono text-[8px] opacity-40">
                  <tr>
                    {activePositionHeaders.map(header => {
                      const direction = activePositionSortDirection(header.key);
                      const priority = activePositionSortPriority(header.key);
                      return (
                        <th key={header.key} className={`px-1.5 py-2 tracking-widest ${header.rightAlign ? 'text-right' : ''}`}>
                          <button
                            type="button"
                            onClick={(event) => updateActivePositionSort(header.key, event.shiftKey)}
                            className={`inline-flex items-center gap-1 uppercase ${header.rightAlign ? 'justify-end w-full' : ''}`}
                            title="Click: single-column sort. Shift+Click: add/remove this column from multi-sort."
                          >
                            <span>{header.label}</span>
                            <span className="text-[8px] opacity-70 min-w-[14px] text-center">
                              {direction === 'asc' ? '↑' : direction === 'desc' ? '↓' : ''}
                            </span>
                            <span className="text-[8px] opacity-60 min-w-[10px] text-center">
                              {priority ?? ''}
                            </span>
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {holdings.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="px-2 py-16 text-center">
                        <div className="flex flex-col items-center gap-2 opacity-30">
                          <Zap size={24} />
                          <p className="text-xs font-mono uppercase tracking-[0.2em]">Awaiting signal confluence. No open vectors.</p>
                          <p className="text-[10px] font-mono normal-case tracking-normal">Live sync currently reports zero active exchange positions.</p>
                          {filteredSyncNote && (
                            <p className="max-w-xl text-[10px] font-mono normal-case tracking-normal text-amber-700 opacity-100">{filteredSyncNote}</p>
                          )}
                        </div>
                      </td>
                    </tr>
                  ) : (
                    sortedActivePositionRows.map((row) => {
                      const h = row.holding;
                      const { mark, contracts, margin, notional, unrealizedPnl: pnlVal, pnlPct: pnlPctVal, closeSide, displaySymbol } = row;
                      return (
                        <tr key={h.id} className="hover:bg-gray-50/50 transition-colors group cursor-pointer" onClick={() => setSymbol(h.symbol)}>
                        <td className="px-1.5 py-2.5 font-mono text-[11px] opacity-70">
                         {row.exchange}
                          </td>
                          <td className="px-1.5 py-2.5">
                              <span className={`text-[9px] font-black px-1.5 py-0.5 rounded-sm ${h.side === 'SHORT' ? 'bg-rose-100 text-rose-800' : 'bg-emerald-100 text-emerald-800'}`}>{h.side}</span>
                          </td>
                        <td className="px-1.5 py-2.5 font-mono text-[11px] font-black uppercase tracking-tight">
                          {displaySymbol}
                        </td>
                          <td className="px-1.5 py-2.5 font-mono text-[11px] opacity-60">
                          {contracts < 1 ? contracts.toFixed(8) : contracts.toFixed(4)}
                          </td>
                          <td className="px-1.5 py-2.5 font-mono text-[11px] opacity-60">
                             ${formatPrice(h.entryPrice)}
                          </td>
                          <td className={`px-1.5 py-2.5 font-mono text-[11px] font-bold ${pnlVal > 0 ? 'text-emerald-600' : pnlVal < 0 ? 'text-rose-600' : 'text-[#141414]'}`}>
                          ${formatPrice(mark)}
                          </td>
                          <td className="px-1.5 py-2.5 font-mono text-[11px] font-bold">
                          ${margin.toFixed(2)}
                        </td>
                        <td className="px-1.5 py-2.5 font-mono text-[11px] font-bold">
                          ${notional.toFixed(2)}
                        </td>
                          <td className={`px-1.5 py-2.5 font-black text-[13px] ${pnlVal >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                             {pnlVal >= 0 ? '+' : ''}${pnlVal.toFixed(2)}
                        </td>
                        <td className={`px-1.5 py-2.5 font-black text-[13px] ${pnlPctVal >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {pnlPctVal >= 0 ? '+' : ''}{pnlPctVal.toFixed(2)}%
                          </td>
                          <td className="px-1.5 py-2.5 text-right">
                             <button 
                               onClick={(e) => {
                                 e.stopPropagation();
                            executeTrade(closeSide, h.symbol, mark, 'MANUAL_DOCK_CONTROL', h.id);
                               }}
                               className="bg-[#141414] text-white hover:bg-[#F27D26] px-3 py-1 text-[9px] font-black uppercase tracking-tighter transition-all"
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
                        {visibleTradeHistory.length === 0 ? (
                          <tr><td colSpan={3} className="px-4 py-12 text-center text-[10px] opacity-30 italic">No historical nodes recorded.</td></tr>
                        ) : (
                          visibleTradeHistory.map((trade, i) => (
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
                                     {trade.reason && <span className="text-[8px] opacity-40">{trade.reason}</span>}
                                  </div>
                               </td>
                               <td className="px-4 py-3 text-right">
                                  <div className="flex items-center justify-end gap-2 mb-1">
                                    <span className={`text-[8px] font-black px-1.5 py-0.5 rounded-sm ${
                                      (trade.status || 'FILLED') === 'FILLED'
                                        ? 'bg-emerald-100 text-emerald-700'
                                        : (trade.status || 'FILLED') === 'SUBMITTED'
                                          ? 'bg-sky-100 text-sky-700'
                                          : (trade.status || 'FILLED') === 'SKIPPED'
                                            ? 'bg-amber-100 text-amber-700'
                                            : 'bg-rose-100 text-rose-700'
                                    }`}>
                                      {trade.status || 'FILLED'}
                                    </span>
                                  </div>
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

             <section className="bg-white border-2 border-[#141414] shadow-[8px_8px_0px_0px_#141414] overflow-hidden flex flex-col h-[400px]">
                <div className="bg-gray-50 border-b border-[#141414]/10 p-4 flex items-center justify-between">
                   <div className="flex items-center gap-2">
                     <Activity size={14} className="opacity-40" />
                     <h3 className="font-mono text-[10px] uppercase tracking-widest font-bold">Command Logs</h3>
                   </div>
                   <button onClick={() => setSystemLogs([])} className="text-[9px] font-bold opacity-30 hover:opacity-100 uppercase transition-opacity">Clear All</button>
                </div>
                <div className="flex-grow overflow-y-auto custom-scrollbar p-3 space-y-2">
                  {systemLogs.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-[10px] opacity-30 italic">No command logs yet.</div>
                  ) : (
                    systemLogs.map((log, i) => (
                      <div key={i} className={`border px-3 py-2 text-[10px] font-mono ${
                        log.type === 'success'
                          ? 'border-emerald-200 bg-emerald-50/60 text-emerald-900'
                          : log.type === 'warning'
                            ? 'border-amber-200 bg-amber-50/60 text-amber-900'
                            : 'border-gray-200 bg-gray-50/60 text-gray-800'
                      }`}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-black uppercase opacity-70">{log.type}</span>
                          <span className="opacity-50">{log.time}</span>
                        </div>
                        <div className="leading-relaxed">
                          {log.repeatCount > 1 ? `${log.message} ... (x${log.repeatCount})` : log.message}
                        </div>
                      </div>
                    ))
                  )}
                </div>
             </section>

          </div>
        </div>
      </div>
    </div>

          {/* Strategy Laboratory (Backtest Module) */}
          <div className={activeTab === 'BACKTEST' ? 'block' : 'hidden'}>
            <div className="w-full">
              <BacktestModule symbol={symbol} availableSymbols={availableSymbols} strategyConfig={strategyConfig} />
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
    <div className="bg-white border-2 border-[#141414] px-4 py-3.5 flex items-center justify-between group hover:bg-[#141414] hover:text-white transition-colors duration-300 font-sans">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-[#141414] text-white group-hover:bg-[#F27D26] transition-colors">
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-[10px] uppercase font-bold opacity-40 tracking-tighter group-hover:opacity-60">{label}</p>
          <div className="flex flex-col">
            <p className="whitespace-nowrap text-[24px] font-black tabular-nums tracking-tighter leading-none">{value}</p>
            {subValue && (
              <div className="mt-0.5 font-mono uppercase text-[8px] font-bold opacity-60 break-words">
                {subValue}
              </div>
            )}
          </div>
        </div>
      </div>
      {trend && (
        <div className={trend === 'up' ? 'text-emerald-600' : 'text-rose-600'}>
          {trend === 'up' ? <ArrowUpRight size={22} /> : <ArrowDownRight size={22} />}
        </div>
      )}
    </div>
  );
};
