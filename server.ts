import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import * as ccxt from 'ccxt';
import dotenv from 'dotenv';
import cors from 'cors';
import crypto from 'crypto';

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  const liveQuoteAllowlist = (process.env.LIVE_QUOTE_ALLOWLIST || 'USDT,FDUSD,USDC,BUSD,TUSD,BTC,ETH,BNB')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
  const liveFuturesQuoteAllowlist = (process.env.LIVE_FUTURES_QUOTE_ALLOWLIST || 'USDT,USDC')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
  const unsupportedSymbolSkips = new Map<string, { until: number; count: number; reason: string }>();
  let cachedBinancePositionMode: { dualSidePosition: boolean; fetchedAt: number } | null = null;
  const binanceRouteHealth = {
    positions: 'UNKNOWN',
    orders: 'UNKNOWN',
    updatedAt: 0,
  };
  const nonTradableQuoteBases = new Set(['USDT', 'USDC', 'BUSD', 'TUSD', 'USDP', 'FDUSD']);

  const publicRateLimitState = {
    bannedUntil: 0,
    backoffUntil: 0,
  };
  const privateSyncState = {
    failCount: 0,
    backoffUntil: 0,
    authFailCount: 0,
    authBlockedUntil: 0,
  };
  const publicExchangeInfoCache = new Map<string, { symbols: any[]; updatedAt: number }>();
  let publicTicker24hCache: { rows: any[]; updatedAt: number } | null = null;
  let privateBalanceCache: { payload: any; updatedAt: number } | null = null;
  const binanceServerTimeState = {
    offsetMs: 0,
    syncedAt: 0,
  };
  type PublicKlineCacheEntry = { payload: any[]; updatedAt: number; source: string };
  const publicKlineCache = new Map<string, PublicKlineCacheEntry>();
  const inflightPublicKlineRequests = new Map<string, Promise<PublicKlineCacheEntry | null>>();
  const MAX_BACKOFF_MS = 5 * 60 * 1000; // cap backoff at 5 minutes
  const MAX_AUTH_BLOCK_MS = 10 * 60 * 1000; // cap auth block at 10 minutes
  const PRIVATE_BALANCE_CACHE_MS = 4000;
  const PRIVATE_BALANCE_STALE_WHILE_BLOCKED_MS = 2 * 60 * 1000;
  const MAX_PUBLIC_KLINE_CACHE_ENTRIES = 2200;
  const PUBLIC_KLINE_STALE_WHILE_BLOCKED_MS = 20 * 60 * 1000;
  const DEFAULT_BINANCE_RECV_WINDOW = '15000';
  const throttledLogState = new Map<string, number>();
  const logOnceState = new Set<string>();
  const routeHitState = new Map<string, { count: number; lastLoggedAt: number; latestSample: string }>();

  const logWithThrottle = (
    level: 'log' | 'warn' | 'error',
    key: string,
    message: string,
    intervalMs: number,
  ) => {
    const now = Date.now();
    const last = throttledLogState.get(key) || 0;
    if (now - last < intervalMs) return;
    throttledLogState.set(key, now);
    if (level === 'warn') console.warn(message);
    else if (level === 'error') console.error(message);
    else console.log(message);
  };

  const logOnce = (
    level: 'log' | 'warn' | 'error',
    key: string,
    message: string,
  ) => {
    if (logOnceState.has(key)) return;
    logOnceState.add(key);
    if (level === 'warn') console.warn(message);
    else if (level === 'error') console.error(message);
    else console.log(message);
  };

  const loadFallbackFuturesExchangeInfo = () => {
    const fallbackPath = path.resolve(process.cwd(), 'binance_futures.json');
    if (!fs.existsSync(fallbackPath)) return [] as any[];
    try {
      const parsed = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
      const symbols = Array.isArray(parsed?.symbols) ? parsed.symbols : [];
      return symbols.map((symbol: any) => ({ ...symbol, marketType: 'futures' }));
    } catch (error: any) {
      logWithThrottle('warn', 'exchangeInfo-fallback-read', `[TradeEdge] exchangeInfo: failed to read local futures fallback (${error?.message || 'unknown error'})`, 60000);
      return [] as any[];
    }
  };

  const getPublicBlockedUntil = () => Math.max(publicRateLimitState.bannedUntil, publicRateLimitState.backoffUntil);
  const getPrivateBlockedUntil = () => Math.max(privateSyncState.authBlockedUntil, privateSyncState.backoffUntil);

  const traceBinanceRoutesEnabled = false;
  const syncDebugLogsEnabled = false;

  const recordBinanceRouteHit = (route: string, sample: string, intervalMs = 15000) => {
    if (!traceBinanceRoutesEnabled) {
      return;
    }

    const key = `route-hit:${route}`;
    const now = Date.now();
    const current = routeHitState.get(key) || { count: 0, lastLoggedAt: now, latestSample: sample };
    current.count += 1;
    current.latestSample = sample;
    if (now - current.lastLoggedAt >= intervalMs) {
      console.log(`[TradeEdge Trace] ${route} count=${current.count} windowMs=${intervalMs} latest=${current.latestSample}`);
      current.count = 0;
      current.lastLoggedAt = now;
    }
    routeHitState.set(key, current);
  };

  const logSyncDebug = (key: string, message: string, throttleMs: number) => {
    if (!syncDebugLogsEnabled) return;
    logWithThrottle('log', key, message, throttleMs);
  };

  const setPublicSourceHeaders = (res: express.Response, source: string, cached = false, blockedUntil = 0) => {
    res.setHeader('X-TradeEdge-Source', source);
    res.setHeader('X-TradeEdge-Cached', cached ? '1' : '0');
    if (blockedUntil > 0) {
      res.setHeader('X-TradeEdge-Blocked-Until', String(blockedUntil));
    }
  };

  const getPublicKlineCacheKey = (symbol: string, interval: string, limit: number, mode: string) => {
    return `${mode}:${String(symbol || '').toUpperCase()}:${String(interval || '1d').toLowerCase()}:${Math.max(1, Number(limit) || 500)}`;
  };

  const getPublicKlineCacheTtlMs = (interval: string) => {
    const normalized = String(interval || '1d').toLowerCase();
    if (normalized === '1m') return 15_000;
    if (normalized === '3m' || normalized === '5m') return 30_000;
    if (normalized === '15m' || normalized === '30m') return 60_000;
    if (normalized === '1h' || normalized === '2h' || normalized === '4h') return 90_000;
    return 120_000;
  };

  const getCachedPublicKlines = (cacheKey: string, maxAgeMs: number) => {
    const cached = publicKlineCache.get(cacheKey);
    if (!cached) return null;
    if (Date.now() - cached.updatedAt > maxAgeMs) return null;
    return cached;
  };

  const setCachedPublicKlines = (cacheKey: string, payload: any[], source: string) => {
    if (!Array.isArray(payload) || payload.length === 0) return null;
    const entry: PublicKlineCacheEntry = { payload, updatedAt: Date.now(), source };
    publicKlineCache.delete(cacheKey);
    publicKlineCache.set(cacheKey, entry);
    while (publicKlineCache.size > MAX_PUBLIC_KLINE_CACHE_ENTRIES) {
      const oldestKey = publicKlineCache.keys().next().value;
      if (!oldestKey) break;
      publicKlineCache.delete(oldestKey);
    }
    return entry;
  };

  const getCompactUsdSymbolParts = (raw: string): { compact: string; base: string; quote: string } | null => {
    const compact = String(raw || '').toUpperCase().split(':')[0].replace('/', '');
    const match = compact.match(/^([A-Z0-9]+?)(USDT|USDC|USD)$/);
    if (!match) return null;
    return { compact, base: match[1], quote: match[2] };
  };

  const isNonTradableQuoteBaseSymbol = (raw: string) => {
    const parts = getCompactUsdSymbolParts(raw);
    if (!parts) return true;
    return /(?:USDT|USDC|USD){2,}$/.test(parts.compact) || nonTradableQuoteBases.has(parts.base);
  };

  const isBinanceAuthErrorMessage = (message: string) => {
    const normalized = String(message || '').toLowerCase();
    return (
      normalized.includes('-2015') ||
      normalized.includes('-2014') ||
      normalized.includes('invalid api-key') ||
      normalized.includes('api-key format invalid') ||
      normalized.includes('signature for this request is not valid') ||
      normalized.includes('invalid signature') ||
      normalized.includes('ip, or permissions for action') ||
      normalized.includes('enable futures')
    );
  };

  const isBinanceTimestampErrorMessage = (message: string) => {
    const normalized = String(message || '').toLowerCase();
    return (
      normalized.includes('-1021') ||
      normalized.includes('timestamp for this request is outside of the recvwindow') ||
      normalized.includes('recvwindow')
    );
  };

  const syncBinanceServerTimeOffset = async (force = false) => {
    const now = Date.now();
    if (!force && binanceServerTimeState.syncedAt > 0 && (now - binanceServerTimeState.syncedAt) < 60_000) {
      return binanceServerTimeState.offsetMs;
    }

    const endpoints = [
      'https://fapi.binance.com/fapi/v1/time',
      'https://api.binance.com/api/v3/time',
    ];

    for (const endpoint of endpoints) {
      try {
        const requestStartedAt = Date.now();
        const response = await fetch(endpoint, {
          headers: { 'User-Agent': 'TradeEdge-Bot/1.0' },
        });
        const requestCompletedAt = Date.now();
        if (!response.ok) continue;
        const payload: any = await response.json().catch(() => null);
        const serverTime = Number(payload?.serverTime || 0);
        if (Number.isFinite(serverTime) && serverTime > 0) {
          const roundTripMs = Math.max(0, requestCompletedAt - requestStartedAt);
          const estimatedLocalServerSampleTime = requestStartedAt + Math.round(roundTripMs / 2);
          binanceServerTimeState.offsetMs = serverTime - estimatedLocalServerSampleTime;
          binanceServerTimeState.syncedAt = requestCompletedAt;
          return binanceServerTimeState.offsetMs;
        }
      } catch {
        // Fall through to the next endpoint.
      }
    }

    return binanceServerTimeState.offsetMs;
  };

  const buildBinanceSignedQuery = async (
    apiSecret: string,
    params: Record<string, string>,
    options?: { forceTimeSync?: boolean },
  ) => {
    const offsetMs = await syncBinanceServerTimeOffset(options?.forceTimeSync === true);
    const query = new URLSearchParams({
      ...params,
      recvWindow: params.recvWindow || DEFAULT_BINANCE_RECV_WINDOW,
      timestamp: String(Date.now() + offsetMs),
    });
    const queryString = query.toString();
    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(queryString)
      .digest('hex');

    return { queryString, signature };
  };

  app.use(cors());
  app.use(express.json());
  app.use((req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 500) {
        console.warn(`[TradeEdge HTTP ${res.statusCode}] ${req.method} ${req.originalUrl}`);
      }
    });
    next();
  });

  // Direct Binance API helper for positions (bypasses CCXT method issues)
  const fetchBinancePositionsViaHttp = async (apiKey: string, apiSecret: string): Promise<{ positions: any[]; authError: boolean; message?: string }> => {
    try {
      const endpoints = [
        { label: 'fapi-position-risk', baseUrl: 'https://fapi.binance.com', path: '/fapi/v2/positionRisk' },
        { label: 'papi-um-position-risk', baseUrl: 'https://papi.binance.com', path: '/papi/v1/um/positionRisk' },
      ];

      for (let requestAttempt = 0; requestAttempt < 2; requestAttempt++) {
        let sawAuthError = false;
        let lastMessage = '';
        let sawTimestampError = false;
        const endpointErrors: string[] = [];
        const { queryString, signature } = await buildBinanceSignedQuery(apiSecret, {}, { forceTimeSync: requestAttempt > 0 });

        for (const endpoint of endpoints) {
          const response = await fetch(`${endpoint.baseUrl}${endpoint.path}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
              'X-MBX-APIKEY': apiKey,
              'Content-Type': 'application/json',
            },
          });

          if (!response.ok) {
            const text = await response.text();
            lastMessage = text;
            const authError = response.status === 401 || isBinanceAuthErrorMessage(text);
            sawAuthError = sawAuthError || authError;
            sawTimestampError = sawTimestampError || isBinanceTimestampErrorMessage(text);
            endpointErrors.push(`${endpoint.label}:${response.status}:${text.substring(0, 100)}`);
            continue;
          }

          const data = await response.json();
          if (Array.isArray(data)) {
            binanceRouteHealth.positions = endpoint.label === 'papi-um-position-risk' ? 'PAPI UM' : 'FAPI';
            binanceRouteHealth.updatedAt = Date.now();
            logWithThrottle(
              'log',
              `direct-http-positions-${endpoint.label}-${data.length}`,
              `[TradeEdge] Direct Binance HTTP: Got ${data.length} positions from ${endpoint.label}`,
              2 * 60 * 1000,
            );
            return { positions: data, authError: false };
          }
        }

        if (sawTimestampError && requestAttempt === 0) {
          continue;
        }

        if (endpointErrors.length > 0) {
          const msg = endpointErrors.slice(0, 2).join(' | ');
          const level = sawAuthError ? 'warn' : 'log';
          logOnce(
            level,
            `binance-position-risk-all-failed-${sawAuthError ? 'auth' : sawTimestampError ? 'timestamp' : 'other'}`,
            `[TradeEdge] Binance positionRisk fallback exhausted: ${msg}`,
          );
        }

        return { positions: [], authError: sawAuthError, message: lastMessage || 'positionRisk unavailable' };
      }

      return { positions: [], authError: false, message: 'positionRisk unavailable' };
    } catch (e: any) {
      console.warn(`[TradeEdge] Direct Binance HTTP request failed: ${e?.message}`);
      const errMsg = String(e?.message || '');
      return {
        positions: [],
        authError: isBinanceAuthErrorMessage(errMsg),
        message: errMsg,
      };
    }
  };

  // Secondary direct Binance helper: fetch positions from account endpoints.
  // Useful when /fapi/v2/positionRisk is blocked but account endpoints are still allowed.
  const fetchBinancePositionsFromAccountViaHttp = async (
    apiKey: string,
    apiSecret: string,
  ): Promise<{ 
    positions: any[]; 
    authError: boolean; 
    message?: string;
    accountData?: any;
  }> => {
    const signedGet = async (baseUrl: string, endpoint: string) => {
      for (let requestAttempt = 0; requestAttempt < 2; requestAttempt++) {
        const { queryString, signature } = await buildBinanceSignedQuery(apiSecret, {}, { forceTimeSync: requestAttempt > 0 });
        const url = `${baseUrl}${endpoint}?${queryString}&signature=${signature}`;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'X-MBX-APIKEY': apiKey,
            'Content-Type': 'application/json',
          },
        });

        const text = await response.text();
        let data: any = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = null;
        }

        if (!response.ok && isBinanceTimestampErrorMessage(text) && requestAttempt === 0) {
          continue;
        }

        return { ok: response.ok, status: response.status, text, data };
      }

      return { ok: false, status: 500, text: 'timestamp sync retry exhausted', data: null };
    };

    try {
      const attempts = [
        { label: 'fapi-account', baseUrl: 'https://fapi.binance.com', endpoint: '/fapi/v2/account' },
        { label: 'papi-um-account', baseUrl: 'https://papi.binance.com', endpoint: '/papi/v1/um/account' },
      ];

      let sawAuthError = false;
      const errors: string[] = [];
      let lastAccountData: any = null;

      for (const attempt of attempts) {
        try {
          const response = await signedGet(attempt.baseUrl, attempt.endpoint);
          if (!response.ok) {
            const preview = String(response.text || '').substring(0, 140);
            const authFail = response.status === 401 || isBinanceAuthErrorMessage(preview);
            sawAuthError = sawAuthError || authFail;
            errors.push(`${attempt.label}:${response.status}:${preview}`);
            continue;
          }

          lastAccountData = response.data;
          const rows = Array.isArray(response.data?.positions) ? response.data.positions : [];
          const activeRows = rows.filter((p: any) => {
            const amt = Number(p?.positionAmt || 0);
            return Number.isFinite(amt) && Math.abs(amt) > 0;
          });

          if (activeRows.length > 0 || rows.length === 0) {
            logWithThrottle(
              'log',
              `binance-account-positions-${attempt.label}-${activeRows.length}`,
              `[TradeEdge] ${attempt.label} returned ${activeRows.length} active positions, totalWalletBalance=${response.data?.totalWalletBalance}, totalUnrealizedProfit=${response.data?.totalUnrealizedProfit}, canWithdraw=${response.data?.canWithdraw}`,
              60 * 1000,
            );
            return { 
              positions: activeRows, 
              authError: false,
              accountData: response.data
            };
          }
        } catch (e: any) {
          const msg = String(e?.message || 'unknown error');
          if (isBinanceAuthErrorMessage(msg)) sawAuthError = true;
          errors.push(`${attempt.label}:exception:${msg}`);
        }
      }

      return {
        positions: [],
        authError: sawAuthError,
        message: errors.slice(0, 2).join(' | '),
        accountData: lastAccountData,
      };
    } catch (e: any) {
      const msg = String(e?.message || 'unknown error');
      return {
        positions: [],
        authError: isBinanceAuthErrorMessage(msg),
        message: msg,
      };
    }
  };

  // Fetch Binance position mode so order params can match one-way vs hedge configuration.
  const fetchBinancePositionModeViaHttp = async (
    apiKey: string,
    apiSecret: string,
  ): Promise<{ dualSidePosition: boolean | null }> => {
    try {
      if (cachedBinancePositionMode && Date.now() - cachedBinancePositionMode.fetchedAt < 60_000) {
        return { dualSidePosition: cachedBinancePositionMode.dualSidePosition };
      }

      const endpoints = [
        'https://fapi.binance.com/fapi/v1/positionSide/dual',
        'https://papi.binance.com/papi/v1/um/positionSide/dual',
      ];

      for (let requestAttempt = 0; requestAttempt < 2; requestAttempt++) {
        const { queryString, signature } = await buildBinanceSignedQuery(apiSecret, { recvWindow: '5000' }, { forceTimeSync: requestAttempt > 0 });
        let sawTimestampError = false;

        for (const endpoint of endpoints) {
          const url = `${endpoint}?${queryString}&signature=${signature}`;
          const response = await fetch(url, {
            method: 'GET',
            headers: {
              'X-MBX-APIKEY': apiKey,
              'Content-Type': 'application/json',
            },
          });

          if (!response.ok) {
            const text = await response.text();
            sawTimestampError = sawTimestampError || isBinanceTimestampErrorMessage(text);
            continue;
          }

          const json: any = await response.json();
          const raw = json?.dualSidePosition;
          const dualSidePosition = typeof raw === 'boolean' ? raw : String(raw || '').toLowerCase() === 'true';

          cachedBinancePositionMode = {
            dualSidePosition,
            fetchedAt: Date.now(),
          };
          return { dualSidePosition };
        }

        if (!sawTimestampError) {
          break;
        }
      }

      return { dualSidePosition: null };
    } catch {
      return { dualSidePosition: null };
    }
  };

  type BinanceSignedEndpoint = {
    label: string;
    baseUrl: string;
    endpoint: string;
  };

  type BinanceAuditTrade = {
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

  type BinanceAuditIncome = {
    symbol: string;
    asset: string;
    incomeType: string;
    income: number;
    info: string;
    time: number;
    tranId: string;
    tradeId: string;
  };

  type BinanceSignedMethod = 'GET' | 'POST' | 'DELETE';

  const sendBinanceSignedRequest = async (
    apiKey: string,
    apiSecret: string,
    endpoints: BinanceSignedEndpoint[],
    method: BinanceSignedMethod,
    params: Record<string, string>,
  ) => {
    let lastMessage = 'unknown Binance signed request error';
    let sawAuthError = false;

    for (const candidate of endpoints) {
      for (let requestAttempt = 0; requestAttempt < 2; requestAttempt++) {
        const { queryString, signature } = await buildBinanceSignedQuery(apiSecret, {
          ...params,
          recvWindow: params.recvWindow || DEFAULT_BINANCE_RECV_WINDOW,
        }, { forceTimeSync: requestAttempt > 0 });

        const signedPayload = `${queryString}&signature=${signature}`;
        const isBodyMethod = method === 'POST';
        const response = await fetch(
          isBodyMethod ? `${candidate.baseUrl}${candidate.endpoint}` : `${candidate.baseUrl}${candidate.endpoint}?${signedPayload}`,
          {
            method,
            headers: {
              'X-MBX-APIKEY': apiKey,
              'Content-Type': isBodyMethod ? 'application/x-www-form-urlencoded' : 'application/json',
            },
            body: isBodyMethod ? signedPayload : undefined,
          }
        );

        const text = await response.text();
        let parsed: any = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = null;
        }

        if (response.ok) {
          return {
            label: candidate.label,
            data: parsed,
          };
        }

        const errorMessage = String(parsed?.msg || parsed?.message || text || response.statusText || 'unknown error');
        lastMessage = errorMessage;
        if (isBinanceAuthErrorMessage(errorMessage)) {
          sawAuthError = true;
        }
        if (isBinanceTimestampErrorMessage(errorMessage) && requestAttempt === 0) {
          continue;
        }
        break;
      }
    }

    const error: any = new Error(lastMessage);
    error.authError = sawAuthError;
    throw error;
  };

  const fetchBinanceSignedJson = async (
    apiKey: string,
    apiSecret: string,
    endpoints: BinanceSignedEndpoint[],
    params: Record<string, string>,
  ) => {
    return await sendBinanceSignedRequest(apiKey, apiSecret, endpoints, 'GET', params);
  };

  const fetchBinancePortfolioMarginAccountViaHttp = async (
    apiKey: string,
    apiSecret: string,
  ): Promise<{
    accountData: any | null;
    authError: boolean;
    message?: string;
  }> => {
    try {
      const response = await fetchBinanceSignedJson(apiKey, apiSecret, [
        { label: 'papi-account', baseUrl: 'https://papi.binance.com', endpoint: '/papi/v1/account' },
      ], {});
      return {
        accountData: response?.data || null,
        authError: false,
      };
    } catch (error: any) {
      const message = String(error?.message || 'portfolio margin account unavailable');
      return {
        accountData: null,
        authError: isBinanceAuthErrorMessage(message),
        message,
      };
    }
  };

  const fetchBinancePortfolioMarginBalanceViaHttp = async (
    apiKey: string,
    apiSecret: string,
  ): Promise<{
    rows: any[];
    authError: boolean;
    message?: string;
  }> => {
    try {
      const response = await fetchBinanceSignedJson(apiKey, apiSecret, [
        { label: 'papi-balance', baseUrl: 'https://papi.binance.com', endpoint: '/papi/v1/balance' },
      ], {});
      return {
        rows: Array.isArray(response?.data) ? response.data : [],
        authError: false,
      };
    } catch (error: any) {
      const message = String(error?.message || 'portfolio margin balance unavailable');
      return {
        rows: [],
        authError: isBinanceAuthErrorMessage(message),
        message,
      };
    }
  };

  const fetchBinanceAccountAuditViaHttp = async (
    apiKey: string,
    apiSecret: string,
    options: { startTime: number; endTime: number; limit: number },
  ): Promise<{
    trades: BinanceAuditTrade[];
    incomes: BinanceAuditIncome[];
    tradeRoute: string;
    incomeRoute: string;
  }> => {
    const client = getExchange();
    const maxWindowMs = (7 * 24 * 60 * 60 * 1000) - 1;

    const fetchFromCcxtOrHttp = async (
      ccxtFetchers: Array<{ label: string; fn: () => Promise<any> }>,
      httpEndpoints: BinanceSignedEndpoint[],
      params: Record<string, string>,
    ) => {
      let lastError: any = null;

      for (const fetcher of ccxtFetchers) {
        try {
          const data = await fetcher.fn();
          if (Array.isArray(data)) {
            return { label: fetcher.label, data };
          }
        } catch (error: any) {
          lastError = error;
        }
      }

      try {
        return await fetchBinanceSignedJson(apiKey, apiSecret, httpEndpoints, params);
      } catch (error: any) {
        if (lastError && !error?.message) {
          throw lastError;
        }
        throw error;
      }
    };

    const tradeRouteLabels = new Set<string>();
    const incomeRouteLabels = new Set<string>();
    const tradeDedup = new Set<string>();
    const incomeDedup = new Set<string>();
    const trades: BinanceAuditTrade[] = [];
    const incomes: BinanceAuditIncome[] = [];

    const normalizedStartTime = Math.max(0, options.startTime);
    const normalizedEndTime = Math.max(normalizedStartTime, options.endTime);

    for (let windowStart = normalizedStartTime; windowStart <= normalizedEndTime; windowStart += (maxWindowMs + 1)) {
      const windowEnd = Math.min(normalizedEndTime, windowStart + maxWindowMs);
      const params = {
        startTime: String(windowStart),
        endTime: String(windowEnd),
        limit: String(options.limit),
      };

      const tradeResponse = await fetchFromCcxtOrHttp([
        { label: 'ccxt-papiGetUmUserTrades', fn: async () => await (client as any).papiGetUmUserTrades?.(params) },
        { label: 'ccxt-fapiPrivateGetUserTrades', fn: async () => await (client as any).fapiPrivateGetUserTrades?.(params) },
      ], [
        { label: 'papi-um-userTrades', baseUrl: 'https://papi.binance.com', endpoint: '/papi/v1/um/userTrades' },
        { label: 'fapi-userTrades', baseUrl: 'https://fapi.binance.com', endpoint: '/fapi/v1/userTrades' },
      ], params);
      tradeRouteLabels.add(tradeResponse.label);

      const incomeResponse = await fetchFromCcxtOrHttp([
        { label: 'ccxt-papiGetUmIncome', fn: async () => await (client as any).papiGetUmIncome?.(params) },
        { label: 'ccxt-fapiPrivateGetIncome', fn: async () => await (client as any).fapiPrivateGetIncome?.(params) },
      ], [
        { label: 'papi-um-income', baseUrl: 'https://papi.binance.com', endpoint: '/papi/v1/um/income' },
        { label: 'fapi-income', baseUrl: 'https://fapi.binance.com', endpoint: '/fapi/v1/income' },
      ], params);
      incomeRouteLabels.add(incomeResponse.label);

      (Array.isArray(tradeResponse.data) ? tradeResponse.data : []).forEach((row: any) => {
        const normalized: BinanceAuditTrade = {
          symbol: String(row?.symbol || '').toUpperCase(),
          side: String(row?.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
          price: Number(row?.price || 0),
          qty: Number(row?.qty || row?.executedQty || 0),
          quoteQty: Number(row?.quoteQty || 0),
          realizedPnl: Number(row?.realizedPnl || 0),
          commission: Number(row?.commission || 0),
          commissionAsset: String(row?.commissionAsset || '').toUpperCase(),
          time: Number(row?.time || 0),
          orderId: String(row?.orderId || row?.id || ''),
        };
        if (!(normalized.time > 0)) return;
        const dedupKey = `${normalized.orderId}:${normalized.time}:${normalized.symbol}:${normalized.side}:${normalized.qty}`;
        if (tradeDedup.has(dedupKey)) return;
        tradeDedup.add(dedupKey);
        trades.push(normalized);
      });

      (Array.isArray(incomeResponse.data) ? incomeResponse.data : []).forEach((row: any) => {
        const normalized: BinanceAuditIncome = {
          symbol: String(row?.symbol || '').toUpperCase(),
          asset: String(row?.asset || '').toUpperCase(),
          incomeType: String(row?.incomeType || '').toUpperCase(),
          income: Number(row?.income || 0),
          info: String(row?.info || ''),
          time: Number(row?.time || 0),
          tranId: String(row?.tranId || ''),
          tradeId: String(row?.tradeId || ''),
        };
        if (!(normalized.time > 0)) return;
        const dedupKey = `${normalized.tranId}:${normalized.tradeId}:${normalized.time}:${normalized.incomeType}:${normalized.income}`;
        if (incomeDedup.has(dedupKey)) return;
        incomeDedup.add(dedupKey);
        incomes.push(normalized);
      });
    }

    return {
      trades,
      incomes,
      tradeRoute: Array.from(tradeRouteLabels).join(',') || 'UNKNOWN',
      incomeRoute: Array.from(incomeRouteLabels).join(',') || 'UNKNOWN',
    };
  };

  // Exchange Client (Lazy Init)
  let exchangeInstance: ccxt.Exchange | null = null;
  const hasConfiguredKeys = () => !!(
    (process.env.BINANCE_LIVE_API_KEY && process.env.BINANCE_LIVE_API_SECRET) ||
    (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET) ||
    (process.env.BINANCE_KEY && process.env.BINANCE_SECRET) ||
    (process.env.GEMINI_LIVE_API_KEY && process.env.GEMINI_LIVE_API_SECRET) ||
    (process.env.GEMINI_API_KEY && process.env.GEMINI_API_SECRET) ||
    (process.env.GEMINI_KEY && process.env.GEMINI_SECRET)
  );
  const getPreferredBinanceCredentials = () => {
    const candidates = [
      { key: (process.env.BINANCE_KEY || '').trim(), secret: (process.env.BINANCE_SECRET || '').trim(), source: 'BINANCE_KEY' },
      { key: (process.env.BINANCE_API_KEY || '').trim(), secret: (process.env.BINANCE_API_SECRET || '').trim(), source: 'BINANCE_API_KEY' },
      { key: (process.env.BINANCE_LIVE_API_KEY || '').trim(), secret: (process.env.BINANCE_LIVE_API_SECRET || '').trim(), source: 'BINANCE_LIVE_API_KEY' },
    ];
    return candidates.find(c => c.key.length > 5 && c.secret.length > 5) || { key: '', secret: '', source: 'none' };
  };
  const preferGemini = () => (process.env.EXCHANGE || '').toLowerCase() === 'gemini';
  const getExchange = () => {
    if (!exchangeInstance) {
      const preferredBinance = getPreferredBinanceCredentials();
      const bKey = preferredBinance.key;
      const bSecret = preferredBinance.secret;
      const gKey = (process.env.GEMINI_LIVE_API_KEY || process.env.GEMINI_API_KEY || process.env.GEMINI_KEY || '').trim();
      const gSecret = (process.env.GEMINI_LIVE_API_SECRET || process.env.GEMINI_API_SECRET || process.env.GEMINI_SECRET || '').trim();

      // Signature of Gemini v1 API keys is starting with 'account-'
      const isGeminiKey = (k: string) => k.toLowerCase().startsWith('account-');
      
      const hasBinanceCreds = bKey.length > 5 && bSecret.length > 5;
      const hasGeminiCreds = gKey.length > 5 && gSecret.length > 5;
      const exchangePreference = (process.env.EXCHANGE || '').toLowerCase();

      // Selection order:
      // 1) Explicit EXCHANGE env var.
      // 2) Default to Binance when both are available.
      // 3) Fallback to Gemini only when Binance is not configured.
      let useGemini = false;
      if (exchangePreference === 'gemini') {
        useGemini = true;
      } else if (exchangePreference === 'binance') {
        useGemini = false;
      } else {
        useGemini = !hasBinanceCreds && hasGeminiCreds;
      }
      
      const apiKey = useGemini ? (isGeminiKey(gKey) || gKey.length > 5 ? gKey : bKey) : bKey;
      const secret = useGemini ? (isGeminiKey(gKey) || gKey.length > 5 ? gSecret : bSecret) : bSecret;
      
      if (!apiKey || !secret || apiKey.length < 5) {
        throw new Error('Valid Exchange API Keys required. Add BINANCE_KEY/SECRET, BINANCE_API_KEY/SECRET, GEMINI_KEY/SECRET, or GEMINI_LIVE_API_KEY/SECRET in .env.');
      }

      if (useGemini) {
         console.warn(`[TradeEdge] Initializing GEMINI exchange client (Key: ${apiKey.substring(0, 12)}...)`);
         exchangeInstance = new ccxt.gemini({
           apiKey,
           secret,
           enableRateLimit: true,
         });
      } else {
        console.warn(`[TradeEdge] Initializing BINANCE client from ${preferredBinance.source} (Key: ${apiKey.substring(0, 8)}...)`);
         exchangeInstance = new ccxt.binance({
           apiKey,
           secret,
           enableRateLimit: true,
           options: { 
             defaultType: 'future',
              adjustForTimeDifference: true,
              portfolioMargin: true,
              defaultPositionSide: 'BOTH'
           }
         });

         const livePapiBase = (process.env.BINANCE_LIVE_BASE_URL || '').trim();
         if (livePapiBase) {
           (exchangeInstance as any).urls = {
             ...(exchangeInstance as any).urls,
             api: {
               ...((exchangeInstance as any).urls?.api || {}),
               papi: livePapiBase,
             },
           };
         }
      }
    }
    return exchangeInstance;
  };

  // API Routes
  app.get('/api/health', async (req, res) => {
    let outboundIp = 'unknown';
    const now = Date.now();
    const publicBlockedUntil = getPublicBlockedUntil();
    const privateBlockedUntil = getPrivateBlockedUntil();
    try {
      const providers = [
        'https://api.ipify.org?format=json',
        'https://api64.ipify.org?format=json',
        'https://ifconfig.me/all.json',
        'https://ipapi.co/json/',
        'https://api.myip.com'
      ];
      
      for (const url of providers) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 4000);
          
          const ipResp = await fetch(url, { 
            signal: controller.signal,
            headers: { 'User-Agent': 'TradeEdge-Bot/1.0' }
          });
          clearTimeout(timeoutId);
          
          if (!ipResp.ok) continue;

          const ipData: any = await ipResp.json();
          outboundIp = ipData.ip || ipData.ip_addr || ipData.query || ipData.data?.ip || 'unknown';
          
          if (outboundIp !== 'unknown' && (outboundIp.includes('.') || outboundIp.includes(':'))) {
            break;
          }
        } catch (e) {
          continue;
        }
      }
    } catch (e) {
      console.warn('Network layer failed to resolve outbound IP');
    }

    const currentExchange = exchangeInstance ? exchangeInstance.id : 'none';

    res.json({ 
      status: 'ok', 
      mode: process.env.NODE_ENV, 
      exchange: currentExchange,
      type: currentExchange === 'binance' ? 'FUTURES' : 'SPOT',
      outboundIp,
      binanceRouteHealth,
      blockedUntil: publicBlockedUntil > now ? publicBlockedUntil : 0,
      publicBlockedUntil: publicBlockedUntil > now ? publicBlockedUntil : 0,
      privateBlockedUntil: privateBlockedUntil > now ? privateBlockedUntil : 0,
      config: {
        realTradingEnabled: process.env.ENABLE_REAL_TRADING === 'true',
        hasKeys: !!(
          (process.env.BINANCE_LIVE_API_KEY && process.env.BINANCE_LIVE_API_SECRET) ||
          (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET) ||
          (process.env.BINANCE_KEY && process.env.BINANCE_SECRET) ||
          (process.env.GEMINI_LIVE_API_KEY && process.env.GEMINI_LIVE_API_SECRET) ||
          (process.env.GEMINI_API_KEY && process.env.GEMINI_API_SECRET) ||
          (process.env.GEMINI_KEY && process.env.GEMINI_SECRET)
        )
      }
    });
  });

  app.post('/api/binance/transfer', async (req, res) => {
    try {
      if (process.env.ENABLE_REAL_TRADING !== 'true') {
        throw new Error('REAL TRADING DISABLED: Set ENABLE_REAL_TRADING=true.');
      }

      const client = getExchange();
      if (client.id !== 'binance') {
        return res.status(400).json({
          status: 'error',
          message: 'Transfer API currently supports Binance only.',
        });
      }

      const rawAmount = Number(req.body?.amount);
      const asset = String(req.body?.asset || 'USDT').toUpperCase();
      const direction = String(req.body?.direction || 'SPOT_TO_UM').toUpperCase();

      if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid amount. Provide a positive numeric amount.',
        });
      }

      const transferTypeMap: Record<string, string> = {
        SPOT_TO_UM: 'MAIN_UMFUTURE',
        UM_TO_SPOT: 'UMFUTURE_MAIN',
      };

      const type = transferTypeMap[direction];
      if (!type) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid direction. Use SPOT_TO_UM or UM_TO_SPOT.',
        });
      }

      const preferredBinance = getPreferredBinanceCredentials();
      const apiKey = preferredBinance.key;
      const apiSecret = preferredBinance.secret;
      if (!apiKey || !apiSecret) {
        throw new Error('Binance API keys are missing. Check your .env credentials.');
      }

      const amount = Number(rawAmount.toFixed(8));
      const recvWindow = DEFAULT_BINANCE_RECV_WINDOW;
      const { queryString, signature } = await buildBinanceSignedQuery(apiSecret, {
        type,
        asset,
        amount: amount.toString(),
        recvWindow,
      });

      const url = `https://api.binance.com/sapi/v1/asset/transfer?${queryString}&signature=${signature}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      const text = await response.text();
      const parsed = (() => {
        try {
          return JSON.parse(text);
        } catch {
          return { raw: text };
        }
      })();

      if (!response.ok) {
        const errMsg = parsed?.msg || parsed?.raw || `Binance transfer failed (${response.status})`;
        return res.status(500).json({
          status: 'error',
          message: errMsg,
          code: parsed?.code,
          direction,
          asset,
          amount,
        });
      }

      res.json({
        status: 'success',
        transfer: {
          direction,
          type,
          asset,
          amount,
          tranId: parsed?.tranId,
        },
        raw: parsed,
      });
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error?.message || 'Transfer failed' });
    }
  });

  app.get('/api/binance/balance', async (req, res) => {
    // Refuse the call while we're still in a ban or backoff window
    const now = Date.now();
    const forceFresh = String(req.query.fresh || '0') === '1';
    recordBinanceRouteHit('private.balance', `fresh=${forceFresh ? 1 : 0}`);
    const getStalePrivateBalancePayload = (reason: string) => {
      if (!privateBalanceCache) return null;
      const ageMs = now - privateBalanceCache.updatedAt;
      if (ageMs > PRIVATE_BALANCE_STALE_WHILE_BLOCKED_MS) return null;
      return {
        ...privateBalanceCache.payload,
        status: 'cached',
        cached: true,
        staleAgeMs: ageMs,
        authDegraded: true,
        authDegradedMessage: reason,
      };
    };
    if (privateSyncState.authBlockedUntil > now) {
      const cachedPayload = getStalePrivateBalancePayload('Binance auth is temporarily blocked; serving the last successful balance snapshot.');
      if (cachedPayload) {
        return res.json(cachedPayload);
      }
      const waitSec = Math.ceil((privateSyncState.authBlockedUntil - now) / 1000);
      return res.status(401).json({
        status: 'auth_failed',
        retryAfterMs: privateSyncState.authBlockedUntil - now,
        blockedUntil: privateSyncState.authBlockedUntil,
        message: `Binance Futures API auth/permissions failed. Retry in ${waitSec}s after fixing API key permissions.`,
      });
    }

    const publicBlockedUntil = getPublicBlockedUntil();
    if (publicBlockedUntil > now) {
      const cachedPayload = getStalePrivateBalancePayload('Public Binance cooldown active; serving the last successful balance snapshot.');
      if (cachedPayload) {
        return res.json(cachedPayload);
      }
      const waitSec = Math.ceil((publicBlockedUntil - now) / 1000);
      console.warn(`[TradeEdge RateLimit] Private sync suppressed by public Binance cooldown — ${waitSec}s remaining`);
      return res.status(429).json({
        status: 'public_rate_limited',
        blockedUntil: publicBlockedUntil,
        retryAfterMs: publicBlockedUntil - now,
        message: `Public Binance market-data cooldown active. Retry in ${waitSec}s.`,
      });
    }

    if (privateSyncState.backoffUntil > now) {
      const cachedPayload = getStalePrivateBalancePayload('Private Binance sync is cooling down; serving the last successful balance snapshot.');
      if (cachedPayload) {
        return res.json(cachedPayload);
      }
      const waitSec = Math.ceil((privateSyncState.backoffUntil - now) / 1000);
      console.warn(`[TradeEdge RateLimit] Private sync backoff active — ${waitSec}s remaining`);
      return res.status(429).json({
        status: 'private_rate_limited',
        blockedUntil: privateSyncState.backoffUntil,
        retryAfterMs: privateSyncState.backoffUntil - now,
        message: `Private Binance account sync cooling down. Retry in ${waitSec}s.`,
      });
    }

    if (!forceFresh && privateBalanceCache && (now - privateBalanceCache.updatedAt) <= PRIVATE_BALANCE_CACHE_MS) {
      recordBinanceRouteHit('private.balance.cache', `ageMs=${now - privateBalanceCache.updatedAt}`);
      return res.json(privateBalanceCache.payload);
    }

    try {
      const client = getExchange();
      let params: any = {};
      
      if (client.id === 'binance') {
        params = { type: 'future' };
      } else if (client.id === 'gemini') {
        // Gemini handles margin via the account parameter
        params = { account: 'margin' };
      }

      let balanceData: any;
      let papiAccountEquity: number | null = null;
      let papiAvailableBalance: number | null = null;
      let papiBalanceUnrealizedPnl: number | null = null;
      if (client.id === 'gemini') {
        try {
          // Fetch all possible sub-accounts for Gemini
          // According to Gemini API: 'exchange' is the main trading account, 'margin' is margin.
          const [exchange, margin] = await Promise.allSettled([
            client.fetchBalance({ account: 'exchange' }),
            client.fetchBalance({ account: 'margin' })
          ]);
          
          const e = exchange.status === 'fulfilled' ? exchange.value : { total: {} };
          const m = margin.status === 'fulfilled' ? margin.value : { total: {} };
          
          // Merge totals across all sub-accounts
          const total: Record<string, number> = {};
          const allCoins = new Set([...Object.keys(e.total || {}), ...Object.keys(m.total || {})]);
          allCoins.forEach(coin => {
            const valE = Number(e.total?.[coin]) || 0;
            const valM = Number(m.total?.[coin]) || 0;
            total[coin] = valE + valM;
            if (total[coin] > 0) {
              console.log(`[TradeEdge Sync] Gemini Asset ${coin}: Exchange=${valE}, Margin=${valM}`);
            }
          });
          
          balanceData = { total, info: { exchange: e, margin: m } };
        } catch (e) {
          console.warn(`[TradeEdge Sync] Gemini sub-account fetch failed, falling back to default...`);
          balanceData = await client.fetchBalance({});
        }
      } else {
        try {
          balanceData = await client.fetchBalance(params);
        } catch (error: any) {
          console.warn(`[TradeEdge Sync] ${client.id} futures balance fetch failed: ${error?.message || 'unknown error'}`);

          if (client.id === 'binance') {
            const preferredBinance = getPreferredBinanceCredentials();
            const binanceKey = preferredBinance.key;
            const binanceSecret = preferredBinance.secret;

            if (binanceKey && binanceSecret) {
              const accountFallback = await fetchBinancePositionsFromAccountViaHttp(binanceKey, binanceSecret);
              const accountInfo = accountFallback.accountData;
              const walletBalance = Number(
                accountInfo?.totalWalletBalance ??
                accountInfo?.totalCrossWalletBalance ??
                0,
              );
              const accountEquity = Number(
                accountInfo?.actualEquity ??
                accountInfo?.accountEquity ??
                accountInfo?.totalMarginBalance ??
                accountInfo?.totalCrossWalletBalance ??
                accountInfo?.totalWalletBalance ??
                0,
              );
              const availableBalance = Number(
                accountInfo?.availableBalance ??
                accountInfo?.totalAvailableBalance ??
                accountInfo?.maxWithdrawAmount ??
                0,
              );

              if (accountInfo && (Number.isFinite(walletBalance) || Number.isFinite(accountEquity))) {
                logWithThrottle(
                  'warn',
                  'sync-binance-balance-http-fallback',
                  `[TradeEdge Sync] Binance balance fallback recovered via signed account endpoint after CCXT failure.`,
                  60 * 1000,
                );
                balanceData = {
                  total: walletBalance > 0 ? { USDT: walletBalance } : {},
                  info: accountInfo,
                };
                if (Number.isFinite(accountEquity) && accountEquity > 0) {
                  papiAccountEquity = accountEquity;
                }
                if (Number.isFinite(availableBalance) && availableBalance >= 0) {
                  papiAvailableBalance = availableBalance;
                }
              } else {
                throw error;
              }
            } else {
              throw error;
            }
          } else {
            console.warn(`[TradeEdge Sync] ${client.id} targeting ${params.account || 'default'} failed, fallback to default account.`);
            balanceData = await client.fetchBalance({});
          }
        }

        try {
          const preferredBinance = getPreferredBinanceCredentials();
          if (preferredBinance.key && preferredBinance.secret) {
            const pmAccount = await fetchBinancePortfolioMarginAccountViaHttp(preferredBinance.key, preferredBinance.secret);
            if (pmAccount.accountData) {
              const accountEquity = Number(
                pmAccount.accountData.accountEquity ??
                pmAccount.accountData.actualEquity ??
                pmAccount.accountData.totalMarginBalance ??
                0,
              );
              const availableBalance = Number(
                pmAccount.accountData.totalAvailableBalance ??
                pmAccount.accountData.virtualMaxWithdrawAmount ??
                0,
              );
              if (Number.isFinite(accountEquity) && accountEquity > 0) {
                papiAccountEquity = accountEquity;
              }
              if (Number.isFinite(availableBalance) && availableBalance >= 0) {
                papiAvailableBalance = availableBalance;
              }
            }

            const pmBalance = await fetchBinancePortfolioMarginBalanceViaHttp(preferredBinance.key, preferredBinance.secret);
            if (pmBalance.rows.length > 0) {
              const unrealizedPnl = pmBalance.rows.reduce((sum: number, row: any) => {
                const value = Number(row?.umUnrealizedPNL || 0);
                return sum + (Number.isFinite(value) ? value : 0);
              }, 0);
              if (Number.isFinite(unrealizedPnl)) {
                papiBalanceUnrealizedPnl = unrealizedPnl;
              }
            }
          }

          const papiAccount = await (client as any).papiGetAccount?.();
          if (papiAccount) {
            const actual = Number(papiAccount.accountEquity || papiAccount.actualEquity);
            const available = Number(papiAccount.totalAvailableBalance || papiAccount.virtualMaxWithdrawAmount);
            if (!Number.isFinite(papiAccountEquity) && Number.isFinite(actual) && actual > 0) papiAccountEquity = actual;
            if (Number.isFinite(available) && available >= 0) papiAvailableBalance = available;
          }
        } catch {
          // Not all accounts expose PAPI totals; fallback to fetchBalance-derived fields.
        }
      }

      const b = balanceData as any;
      const cashKeys = ['USD', 'USDT', 'GUSD', 'USDC', 'DAI', 'BUSD'];
      let cashTotal = 0;
      let portfolioMarginEquity: number | null = null;
      let uiAvailableBalance: number | null = null;
      const allPositions: Record<string, {
        amount: number,
        total: number,
        side?: 'LONG' | 'SHORT',
        entryPrice?: number,
        unrealizedPnl?: number,
        exchange?: string,
        symbol?: string,
        contracts?: number,
        markPrice?: number,
        notional?: number,
        initialMargin?: number,
        leverage?: number,
      }> = {};
      const filteredSymbols: Array<{ symbol: string; reason: string }> = [];
      const rememberFilteredSymbol = (symbol: string, reason: string) => {
        const normalized = String(symbol || '').toUpperCase();
        if (!normalized) return;
        if (!filteredSymbols.some((entry) => entry.symbol === normalized && entry.reason === reason)) {
          filteredSymbols.push({ symbol: normalized, reason });
        }
      };

      // CCXT standard: b.total contains all balances (coin: amount)
      const totalBalances = b.total || {};
      const markets = await client.loadMarkets();
      
      for (const [coin, amount] of Object.entries(totalBalances)) {
        const val = Number(amount);
        if (val <= 0.00000001) continue; // Skip dust
        
        const coinUpper = coin.toUpperCase();
        
        if (cashKeys.includes(coinUpper)) {
          cashTotal += val;
          continue;
        } 

        // CRITICAL Gemini Ghost Filter: Gemini returns internal sub-account balances 
        // ending in 'T' (Trading) or 'S' (Staked) which must be ignored.
        if (client.id.toLowerCase().includes('gemini')) {
           const isShadow = (coinUpper.endsWith('T') || coinUpper.endsWith('S')) && coinUpper !== 'USDT';
           if (isShadow) {
              console.log(`[TradeEdge Sync] Dropping Gemini Shadow Asset: ${coinUpper}`);
              continue;
           }
        }

        // Verify if this asset has a valid market pair on the exchange
        // This ensures "Index" coins or internal loyalty tokens aren't counted as value
        const hasMarket = markets[`${coinUpper}/USD`] || 
                         markets[`${coinUpper}/USDT`] || 
                         markets[`${coinUpper}/GUSD`] ||
                         markets[`${coinUpper}/BTC`];

        if (hasMarket) {
          allPositions[coinUpper] = { 
            amount: val,
            total: val 
          };
        }
      }

      let totalUnrealizedPnl = 0;
      let authDegraded = false;
      let authDegradedMessage = '';

      if (client.id === 'binance') {
        const upsertPosition = (input: any) => {
          const rawAmt = Number(input?.contracts ?? input?.positionAmt ?? input?.info?.positionAmt ?? 0);
          const contracts = Math.abs(rawAmt);
          if (!Number.isFinite(contracts) || contracts <= 0) return;

          const sideRaw = String(input?.side || input?.positionSide || input?.info?.positionSide || '').toUpperCase();
          const inferredSide: 'LONG' | 'SHORT' = sideRaw === 'SHORT' || rawAmt < 0 ? 'SHORT' : 'LONG';
          const entry = Number(input?.entryPrice ?? input?.info?.entryPrice ?? 0);
          const rawUnrealized = input?.unrealizedPnl ?? input?.unRealizedProfit ?? input?.info?.unRealizedProfit;
          const unrealized = rawUnrealized === undefined || rawUnrealized === null || rawUnrealized === ''
            ? undefined
            : Number(rawUnrealized);
          const mark = Number(input?.markPrice ?? input?.info?.markPrice ?? 0);
          const leverage = Number(input?.leverage ?? input?.info?.leverage ?? 0);
          const rawNotional = Number(input?.notional ?? input?.info?.notional ?? 0);
          const notional = Number.isFinite(rawNotional) && rawNotional !== 0
            ? Math.abs(rawNotional)
            : ((Number.isFinite(mark) && mark > 0 ? mark : entry) * contracts);
          const rawInitialMargin = Number(input?.initialMargin ?? input?.info?.initialMargin ?? 0);
          const initialMargin = Number.isFinite(rawInitialMargin) && rawInitialMargin > 0
            ? rawInitialMargin
            : ((Number.isFinite(leverage) && leverage > 0 && Number.isFinite(notional) && notional > 0)
              ? notional / leverage
              : undefined);

          const symbolRaw = String(input?.symbol || input?.info?.symbol || '').toUpperCase();
          if (!symbolRaw) return;
          const compact = symbolRaw.split(':')[0].replace('/', '');
          const normalized = /(USDT|USDC|USD)$/.test(compact) ? compact : `${compact}USDT`;
          const symbolMatch = getCompactUsdSymbolParts(normalized);
          
          // STRICT VALIDATION: Reject malformed symbols and quote-asset crosses like USDCUSDT.
          if (!symbolMatch || isNonTradableQuoteBaseSymbol(normalized)) {
            rememberFilteredSymbol(normalized, 'quote asset cross or malformed symbol');
            logWithThrottle(
              'warn',
              `sync-invalid-position-${normalized}`,
              `[TradeEdge] Rejecting malformed symbol: "${normalized}" (doesn't match valid trading pair format)`,
              60 * 1000,
            );
            return;
          }

          const displaySymbol = String(input?.symbol || '').includes('/')
            ? String(input?.symbol)
            : (symbolMatch.quote === 'USDT'
              ? `${symbolMatch.base}/USDT:USDT`
              : symbolMatch.quote === 'USDC'
                ? `${symbolMatch.base}/USDC:USDC`
                : `${symbolMatch.base}/USD:USD`);

          allPositions[normalized] = {
            amount: contracts,
            total: contracts,
            side: inferredSide,
            entryPrice: Number.isFinite(entry) && entry > 0 ? entry : undefined,
            unrealizedPnl: Number.isFinite(unrealized) ? unrealized : undefined,
            exchange: 'Binance',
            symbol: displaySymbol,
            contracts,
            markPrice: Number.isFinite(mark) && mark > 0 ? mark : undefined,
            notional: Number.isFinite(notional) && notional > 0 ? notional : undefined,
            initialMargin,
            leverage: Number.isFinite(leverage) && leverage > 0 ? leverage : undefined,
          };
        };

        let positionsFetched = false;
        
        // PRIMARY: Try direct Binance HTTP API (most reliable)
        const preferredBinance = getPreferredBinanceCredentials();
        const binanceKey = preferredBinance.key;
        const binanceSecret = preferredBinance.secret;
        
        if (binanceKey && binanceSecret) {
          const httpPositionResult = await fetchBinancePositionsViaHttp(binanceKey, binanceSecret);
          const httpPositions = httpPositionResult.positions;
          if (httpPositionResult.authError) {
            authDegraded = true;
            authDegradedMessage = httpPositionResult.message || 'Binance private futures endpoint returned auth error (-2015).';
          }
          logSyncDebug(
            'sync-direct-http-attempt-debug',
            `[TradeEdge Sync DEBUG] Direct HTTP attempt: got ${httpPositions.length} positions, authError=${httpPositionResult.authError}${httpPositionResult.message ? `, message=${httpPositionResult.message}` : ''}`,
            60 * 1000,
          );
          if (httpPositions.length > 0) {
            logWithThrottle(
              'log',
              `sync-direct-http-success-${httpPositions.length}`,
              `[TradeEdge Sync] Successfully fetched ${httpPositions.length} positions via direct HTTP API`,
              2 * 60 * 1000,
            );
            httpPositions.forEach(pos => {
              upsertPosition(pos);
            });
            positionsFetched = true;
          } else {
            logOnce(
              'warn',
              'sync-direct-http-zero-positions',
              `[TradeEdge Sync] Direct HTTP API returned 0 positions (may lack permissions)`,
            );

            // SECONDARY: Try account endpoints to pull active positions periodically from exchange state.
            const accountPositionResult = await fetchBinancePositionsFromAccountViaHttp(binanceKey, binanceSecret);
            const accountPositions = accountPositionResult.positions;
            if (accountPositionResult.authError) {
              authDegraded = true;
              if (!authDegradedMessage) {
                authDegradedMessage = accountPositionResult.message || 'Binance account position endpoints returned auth error.';
              }
            }
            if (accountPositions.length > 0) {
              console.log(`[TradeEdge Sync] Recovered ${accountPositions.length} positions via Binance account endpoints`);
              accountPositions.forEach(upsertPosition);
              positionsFetched = true;
              authDegraded = false;
              authDegradedMessage = '';
            }
            
            // CAPTURE account balance data from the response (totalWalletBalance, totalUnrealizedProfit, etc.)
            // Note: papi response structure may differ, so also fall back to calculating from CCXT info if needed
            if (accountPositionResult.accountData) {
              const acctData = accountPositionResult.accountData;
              logSyncDebug(
                'sync-account-data-keys-debug',
                `[TradeEdge Sync DEBUG] Account data keys: ${Object.keys(acctData).join(', ')}`,
                5 * 60 * 1000,
              );
            }
          }
        }
        
        // FALLBACK: Parse UM (Unified Margin) positions from fetchBalance info
        if (!positionsFetched && Array.isArray(b.info)) {
          const umAssets = b.info.filter((row: any) => {
            const umBal = Number(row?.umWalletBalance || 0);
            const umPnl = Number(row?.umUnrealizedPNL || 0);
            const positionInitialMargin = Number(row?.positionInitialMargin || 0);
            const openOrderInitialMargin = Number(row?.openOrderInitialMargin || 0);
            return umBal !== 0 || umPnl !== 0 || positionInitialMargin > 0 || openOrderInitialMargin > 0;
          });
          
          if (umAssets.length > 0) {
            logOnce(
              'log',
              `sync-um-assets-${umAssets.length}`,
              `[TradeEdge Sync] Found ${umAssets.length} assets with UM positions in fetchBalance info`,
            );
            umAssets.forEach((asset: any) => {
              const symbol = String(asset.asset || '').toUpperCase();
              
              // SKIP quote assets (USDT, USDC, BUSD, etc.) - they're not tradable base assets
              const QUOTE_ASSETS = new Set(['USDT', 'USDC', 'BUSD', 'TUSD', 'USDP', 'USDN', 'EUR', 'GBP', 'JPY']);
              if (QUOTE_ASSETS.has(symbol)) {
                logOnce(
                  'log',
                  `sync-skip-quote-${symbol}`,
                  `[TradeEdge Sync] Skipping quote asset: ${symbol} (not a tradable base asset)`,
                );
                return;
              }
              
              const umBal = Number(asset.umWalletBalance || 0);
              const umPnl = Number(asset.umUnrealizedPNL || 0);
              if (symbol && (umBal !== 0 || umPnl !== 0)) {
                const normalizedAssetSymbol = /(USDT|USDC|USD)$/.test(symbol) ? symbol : `${symbol}USDT`;
                const symbolMatch = getCompactUsdSymbolParts(normalizedAssetSymbol);
                if (!symbolMatch || isNonTradableQuoteBaseSymbol(normalizedAssetSymbol) || QUOTE_ASSETS.has(symbolMatch.base)) {
                  rememberFilteredSymbol(normalizedAssetSymbol, 'quote asset cross or malformed symbol');
                  logWithThrottle(
                    'warn',
                    `sync-um-skip-malformed-${normalizedAssetSymbol}`,
                    `[TradeEdge Sync] Skipping malformed UM asset symbol: ${normalizedAssetSymbol}`,
                    60 * 1000,
                  );
                  return;
                }
                const displaySymbol = `${symbolMatch.base}/${symbolMatch.quote}:${symbolMatch.quote}`;
                console.log(`[TradeEdge Sync] UM Asset: ${symbol} balance=${umBal} pnl=${umPnl}`);
                upsertPosition({
                  symbol: displaySymbol,
                  positionAmt: umBal,
                  positionSide: umBal < 0 ? 'SHORT' : 'LONG',
                  contracts: Math.abs(umBal),
                  unrealizedPnl: umPnl,
                  info: {
                    symbol: displaySymbol,
                    positionAmt: umBal,
                    positionSide: umBal < 0 ? 'SHORT' : 'LONG',
                    unRealizedProfit: umPnl,
                  }
                });
              }
            });
            positionsFetched = true;
          }
        }
        
        // FALLBACK: Try CCXT methods if HTTP didn't work
        if (!positionsFetched) {
          try {
            const fetchedPositions = await (client as any).fetchPositions?.(undefined, { type: 'future' });
            if (Array.isArray(fetchedPositions) && fetchedPositions.length > 0) {
              console.log(`[TradeEdge Sync] fetchPositions returned ${fetchedPositions.length} positions`);
              fetchedPositions.forEach(upsertPosition);
              positionsFetched = true;
            } else {
              console.warn(`[TradeEdge Sync] fetchPositions returned empty or not array`);
            }
          } catch (e: any) {
            console.warn(`[TradeEdge Sync] fetchPositions failed: ${e?.message || 'unknown error'}`);
          }
        }

        if (!positionsFetched) {
          const positionRiskFetchers = [
            { name: 'fapiPrivateV2GetPositionRisk', fn: async () => await (client as any).fapiPrivateV2GetPositionRisk?.() },
            { name: 'fapiPrivateGetPositionRisk', fn: async () => await (client as any).fapiPrivateGetPositionRisk?.() },
            { name: 'papiGetUmPositionRisk', fn: async () => await (client as any).papiGetUmPositionRisk?.() },
            { name: 'privateGetUmPositionRisk', fn: async () => await (client as any).privateGetUmPositionRisk?.() },
          ];

          for (const { name, fn } of positionRiskFetchers) {
            try {
              const rows = await fn();
              if (Array.isArray(rows) && rows.length > 0) {
                console.log(`[TradeEdge Sync] ${name} returned ${rows.length} positions`);
                rows.forEach(upsertPosition);
                positionsFetched = true;
                break;
              } else {
                console.warn(`[TradeEdge Sync] ${name} returned empty or not array`);
              }
            } catch (e: any) {
              console.warn(`[TradeEdge Sync] ${name} failed: ${e?.message || 'unknown error'}`);
            }
          }
        }
        
        if (!positionsFetched && Object.keys(allPositions).length === 0) {
          console.warn(`[TradeEdge Sync] WARNING: No positions fetched from any endpoint. Attempting direct account info query...`);
          try {
            const acctInfo = await (client as any).privateGetAccount?.();
            if (acctInfo && Array.isArray(acctInfo.positions)) {
              console.log(`[TradeEdge Sync] Found ${acctInfo.positions.length} positions in account info`);
              acctInfo.positions.forEach((p: any) => {
                if (Number(p.positionAmt || 0) !== 0) {
                  upsertPosition(p);
                }
              });
              positionsFetched = true;
            }
          } catch (e: any) {
            console.warn(`[TradeEdge Sync] Direct account query failed: ${e?.message}`);
          }
        }
        
        if (!positionsFetched && Object.keys(allPositions).length === 0) {
          console.warn(`[TradeEdge Sync] WARNING: No positions fetched from any endpoint. Account may be flat or API keys lack futures permissions.`);
          try {
            const acct = await (client as any).fetchAccount?.();
            if (acct && typeof acct === 'object') {
              console.log(`[TradeEdge Sync] fetchAccount returned account info.`);
              const acctStr = JSON.stringify(acct).substring(0, 300);
              console.log(`[TradeEdge Sync] Account data (truncated): ${acctStr}`);
            }
          } catch (fallbackErr: any) {
            console.warn(`[TradeEdge Sync] Fallback fetchAccount failed: ${fallbackErr?.message}`);
          }
        } else if (positionsFetched || Object.keys(allPositions).length > 0) {
          const loadedCount = Object.keys(allPositions).length;
          if (loadedCount > 0) {
            logWithThrottle(
              'log',
              `sync-total-positions-${loadedCount}`,
              `[TradeEdge Sync] Total positions loaded: ${loadedCount}`,
              2 * 60 * 1000,
            );
          }
        }

        totalUnrealizedPnl = Object.values(allPositions).reduce((sum, p) => {
          const u = Number((p as any)?.unrealizedPnl);
          return Number.isFinite(u) ? sum + u : sum;
        }, 0);
        logSyncDebug(
          'sync-total-unrealized-pnl-debug',
          `[TradeEdge Sync DEBUG] totalUnrealizedPnl from positions: ${totalUnrealizedPnl}`,
          60 * 1000,
        );

        if (Number.isFinite(papiBalanceUnrealizedPnl)) {
          totalUnrealizedPnl = papiBalanceUnrealizedPnl as number;
        }

        // ALSO add UM unrealized PnL from the account info (UM = Unified Margin positions in futures)
        if (Array.isArray(b.info) && totalUnrealizedPnl === 0) {
          const umPnlSum = b.info.reduce((sum: number, row: any) => {
            const umPnl = Number(row?.umUnrealizedPNL || 0);
            if (Number.isFinite(umPnl) && umPnl !== 0) {
              logSyncDebug(
                `sync-um-asset-pnl-${row.asset}`,
                `[TradeEdge Sync DEBUG] ${row.asset}: umUnrealizedPNL=${umPnl}`,
                5 * 60 * 1000,
              );
            }
            return sum + (Number.isFinite(umPnl) ? umPnl : 0);
          }, 0);
          logSyncDebug(
            'sync-um-pnl-sum-debug',
            `[TradeEdge Sync DEBUG] umPnlSum from info array: ${umPnlSum}`,
            60 * 1000,
          );
          if (umPnlSum !== 0) {
            totalUnrealizedPnl = umPnlSum;
            logSyncDebug(
              'sync-um-pnl-used-debug',
              `[TradeEdge Sync DEBUG] Using umPnlSum as totalUnrealizedPnl: ${totalUnrealizedPnl}`,
              60 * 1000,
            );
          }
        }
      }

      if (client.id === 'binance') {
        const infoRows = Array.isArray(b.info) ? b.info : [b.info || {}];
        const info =
          infoRows.find((row: any) => (row?.asset || '').toUpperCase() === 'USDT') ||
          infoRows
            .filter((row: any) => Number.isFinite(Number(row?.totalWalletBalance)))
            .sort((a: any, c: any) => Number(c.totalWalletBalance || 0) - Number(a.totalWalletBalance || 0))[0] ||
          {};
        const pmCandidates = [
          papiAccountEquity,
          Number(info.actualEquity),
          Number(info.accountEquity),
          Number(info.totalMarginBalance),
          Number(info.totalCrossWalletBalance),
          Number(info.totalWalletBalance),
        ].filter(v => Number.isFinite(v) && v > 0);

        if (pmCandidates.length > 0) {
          portfolioMarginEquity = pmCandidates[0];
        }

        if (!portfolioMarginEquity && Array.isArray(info.assets)) {
          const usdtAsset = info.assets.find((a: any) => (a?.asset || '').toUpperCase() === 'USDT');
          const fromAsset = Number(usdtAsset?.marginBalance || usdtAsset?.walletBalance || usdtAsset?.availableBalance);
          if (Number.isFinite(fromAsset) && fromAsset > 0) {
            portfolioMarginEquity = fromAsset;
          }
        }

        if (portfolioMarginEquity && portfolioMarginEquity > 0) {
          cashTotal = portfolioMarginEquity;
        }

        const infoAvailable = Number(info.totalAvailableBalance);
        const infoWithdrawable = Number(info.maxWithdrawAmount);
        const pmAvailableCandidates = [
          papiAvailableBalance,
          infoAvailable,
          infoWithdrawable,
        ].filter(v => Number.isFinite(v) && (v as number) >= 0) as number[];

        const primaryAvailable = pmAvailableCandidates.length > 0 ? pmAvailableCandidates[0] : NaN;
        const hasOpenPositions = Object.keys(allPositions).length > 0;
        const fallbackCash = portfolioMarginEquity && portfolioMarginEquity > 0 ? portfolioMarginEquity : cashTotal;

        if (Number.isFinite(primaryAvailable)) {
          // Use exchange-reported available margin directly.
          // Inflating this with equity can trigger repeated -2019 rejects.
          uiAvailableBalance = primaryAvailable;
        } else {
          uiAvailableBalance = fallbackCash;
        }
      }

      if (uiAvailableBalance === null) {
        uiAvailableBalance = cashTotal;
      }

      const hasUsablePositions = Object.keys(allPositions).length > 0;
      const hasUsableBalance = Number.isFinite(cashTotal) && cashTotal > 0;

      // Avoid false auth alarms when a probe endpoint fails but trading data is otherwise available.
      if (authDegraded && (hasUsablePositions || hasUsableBalance)) {
        authDegraded = false;
        authDegradedMessage = '';
      }

      if (authDegraded && authDegradedMessage) {
        authDegradedMessage = 'Some Binance private endpoints are restricted for this account mode. Trading may still work via compatible endpoints.';
      }
      
      const positionKeys = Object.keys(allPositions);
      const shouldLogSummary = process.env.TRADEEDGE_VERBOSE_SYNC === 'true' || positionKeys.length > 0;
      if (shouldLogSummary) {
        logWithThrottle(
          'log',
          `sync-summary-${client.id}-${positionKeys.length}`,
          `[TradeEdge Sync] ${client.id.toUpperCase()} Summary: Cash=$${cashTotal.toFixed(2)}, Positions=${positionKeys.length}, Valid=${positionKeys.join(',')}`,
          2 * 60 * 1000,
        );
      }
      
      const responsePayload = { 
        status: 'success', 
        exchange: client.id, 
        account: client.id === 'gemini' ? (params.account || 'Primary') : 'Standard',
        balance: { USDT: cashTotal }, 
        equity: portfolioMarginEquity,
        availableBalance: uiAvailableBalance,
        authDegraded,
        authDegradedMessage,
        binanceRouteHealth,
        unrealizedPnl: Number.isFinite(totalUnrealizedPnl) ? totalUnrealizedPnl : 0,
        positions: allPositions,
        filteredSymbols: client.id === 'binance' ? filteredSymbols : [],
        raw: { info: balanceData.info },
        _debug: process.env.NODE_ENV === 'development' ? { 
          positionsCount: Object.keys(allPositions).length, 
          totalUnrealizedPnl,
          info: balanceData.info 
        } : undefined
      };
      privateBalanceCache = {
        payload: responsePayload,
        updatedAt: Date.now(),
      };
      res.json(responsePayload);
      // Successful sync — reset private failure state
      privateSyncState.failCount = 0;
      privateSyncState.backoffUntil = 0;
      privateSyncState.authFailCount = 0;
      privateSyncState.authBlockedUntil = 0;
    } catch (error: any) {
      const msg = String(error?.message || '');
      const statusCode = Number(error?.status || error?.httpCode || 0);

      if (isBinanceAuthErrorMessage(msg)) {
        privateSyncState.authFailCount += 1;
        const blockMs = Math.min(privateSyncState.authFailCount * 2 * 60 * 1000, MAX_AUTH_BLOCK_MS);
        privateSyncState.authBlockedUntil = Date.now() + blockMs;
        return res.status(401).json({
          status: 'auth_failed',
          message: msg,
          blockedUntil: privateSyncState.authBlockedUntil,
          retryAfterMs: blockMs,
        });
      }

      // Detect 418 (IP ban) or 429 (rate limit) from Binance
      if (statusCode === 418 || statusCode === 429 || msg.includes('banned until') || msg.includes('Too many requests')) {
        // Parse the 'banned until' timestamp from the error message if present
        const banMatch = msg.match(/banned until (\d+)/);
        if (banMatch) {
          privateSyncState.backoffUntil = parseInt(banMatch[1], 10);
          console.error(`[TradeEdge RateLimit] Private sync rate limited until ${new Date(privateSyncState.backoffUntil).toISOString()}`);
        } else {
          // No explicit ban time — apply exponential backoff
          privateSyncState.failCount++;
          const backoffMs = Math.min(Math.pow(2, privateSyncState.failCount) * 5000, MAX_BACKOFF_MS);
          privateSyncState.backoffUntil = Date.now() + backoffMs;
          console.error(`[TradeEdge RateLimit] Private sync rate limited (attempt ${privateSyncState.failCount}) — backing off ${backoffMs / 1000}s`);
        }
        res.status(429).json({
          status: 'private_rate_limited',
          message: msg,
          blockedUntil: privateSyncState.backoffUntil,
          bannedUntil: privateSyncState.backoffUntil,
        });
      } else {
        // Generic error — apply small backoff on repeated failures
        privateSyncState.failCount++;
        if (privateSyncState.failCount > 3) {
          const backoffMs = Math.min(privateSyncState.failCount * 10000, MAX_BACKOFF_MS);
          privateSyncState.backoffUntil = Date.now() + backoffMs;
          console.warn(`[TradeEdge Sync] ${privateSyncState.failCount} consecutive failures — backing off ${backoffMs / 1000}s`);
        }
        if (privateBalanceCache && (Date.now() - privateBalanceCache.updatedAt) <= PRIVATE_BALANCE_STALE_WHILE_BLOCKED_MS) {
          console.warn(`[TradeEdge Sync] Serving cached private balance after sync failure: ${msg}`);
          return res.json({
            ...privateBalanceCache.payload,
            status: 'cached',
            cached: true,
            staleAgeMs: Date.now() - privateBalanceCache.updatedAt,
            authDegraded: true,
            authDegradedMessage: 'Live Binance sync failed; serving the last successful balance snapshot.',
          });
        }
        console.error(`[TradeEdge Sync Error] ${msg}`);
        res.status(500).json({ status: 'error', message: msg });
      }
    }
  });

  app.get('/api/binance/account-audit', async (req, res) => {
    try {
      const client = getExchange();
      if (client.id !== 'binance') {
        return res.status(400).json({
          status: 'unsupported_exchange',
          message: 'Account audit is only available for Binance futures accounts.',
        });
      }

      const preferredBinance = getPreferredBinanceCredentials();
      const binanceKey = preferredBinance.key;
      const binanceSecret = preferredBinance.secret;
      if (!binanceKey || !binanceSecret) {
        return res.status(401).json({
          status: 'auth_failed',
          message: 'Binance API keys are required for account audit.',
        });
      }

      const now = Date.now();
      const requestedStart = Number(req.query.startTime || 0);
      const requestedEnd = Number(req.query.endTime || 0);
      const requestedDays = Number(req.query.days || 30);
      const requestedLimit = Number(req.query.limit || 500);
      const endTime = Number.isFinite(requestedEnd) && requestedEnd > 0 ? requestedEnd : now;
      const days = Math.max(1, Math.min(90, Number.isFinite(requestedDays) ? requestedDays : 30));
      const startTime = Number.isFinite(requestedStart) && requestedStart > 0
        ? requestedStart
        : (endTime - (days * 24 * 60 * 60 * 1000));
      const limit = Math.max(10, Math.min(1000, Number.isFinite(requestedLimit) ? requestedLimit : 500));

      const audit = await fetchBinanceAccountAuditViaHttp(binanceKey, binanceSecret, {
        startTime,
        endTime,
        limit,
      });

      const summary = audit.incomes.reduce((acc, entry) => {
        const amount = Number.isFinite(entry.income) ? entry.income : 0;
        acc.netIncome += amount;

        switch (entry.incomeType) {
          case 'REALIZED_PNL':
            acc.realizedPnl += amount;
            break;
          case 'COMMISSION':
            acc.commission += amount;
            break;
          case 'FUNDING_FEE':
            acc.funding += amount;
            break;
          case 'TRANSFER':
            acc.transfer += amount;
            break;
          default:
            acc.other += amount;
            break;
        }

        acc.byType[entry.incomeType] = (acc.byType[entry.incomeType] || 0) + amount;
        return acc;
      }, {
        realizedPnl: 0,
        commission: 0,
        funding: 0,
        transfer: 0,
        other: 0,
        netIncome: 0,
        byType: {} as Record<string, number>,
      });

      return res.json({
        status: 'success',
        exchange: 'binance',
        startTime,
        endTime,
        routeHealth: {
          trades: audit.tradeRoute,
          incomes: audit.incomeRoute,
        },
        trades: audit.trades.sort((a, b) => b.time - a.time),
        incomes: audit.incomes.sort((a, b) => b.time - a.time),
        summary,
      });
    } catch (error: any) {
      const msg = String(error?.message || 'unknown Binance account audit error');
      if (error?.authError || isBinanceAuthErrorMessage(msg)) {
        return res.status(401).json({
          status: 'auth_failed',
          message: msg,
        });
      }
      return res.status(500).json({
        status: 'error',
        message: msg,
      });
    }
  });

  app.post('/api/binance/order', async (req, res) => {
    try {
      if (process.env.ENABLE_REAL_TRADING !== 'true') {
        throw new Error('REAL TRADING DISABLED: Set ENABLE_REAL_TRADING=true.');
      }

      const { symbol, side, amount, positionSide, reduceOnly } = req.body;
      const client = getExchange();
      const normalizedSymbol = String(symbol || '').toUpperCase().replace('/', '').replace(':', '');

      if (isNonTradableQuoteBaseSymbol(normalizedSymbol)) {
        unsupportedSymbolSkips.set(normalizedSymbol, {
          count: (unsupportedSymbolSkips.get(normalizedSymbol)?.count || 0) + 1,
          until: Date.now() + (1000 * 60 * 15),
          reason: 'quote asset cross not tradable',
        });
        throw new Error(`UNSUPPORTED MARKET: ${normalizedSymbol} is a quote-asset cross and cannot be opened as a futures position.`);
      }
      
      let ccxtSymbol = symbol.toUpperCase();
      const isGemini = client.id.toLowerCase().includes('gemini');

      if (isGemini) {
          // Normalize symbols for Gemini CCXT
          ccxtSymbol = ccxtSymbol.toUpperCase()
            .replace('USDT', '/USD')
            .replace('BTCUSD', 'BTC/USD')
            .replace('ETHUSD', 'ETH/USD')
            .replace('SOLUSD', 'SOL/USD')
            .replace('ZECUSD', 'ZEC/USD');
          
          if (!ccxtSymbol.includes('/')) {
            if (ccxtSymbol.endsWith('USD')) ccxtSymbol = ccxtSymbol.replace('USD', '/USD');
            else ccxtSymbol = `${ccxtSymbol}/USD`;
          }

          await client.loadMarkets();
          if (!client.markets[ccxtSymbol]) {
            throw new Error(`gemini does not support market symbol ${ccxtSymbol}. Please choose a supported asset.`);
          }
      }

      console.log(`[TradeEdge ${client.id.toUpperCase()}] Request: ${side} ${amount} ${ccxtSymbol}`);
      
      let order: any;
      if (isGemini) {
          const ticker = await client.fetchTicker(ccxtSymbol);
          const price = ticker.last || ticker.close || 0;
          if (!price) throw new Error(`Market price unavailable for ${ccxtSymbol}`);

          // Slippage buffer for Gemini (Limit price set higher/lower to guarantee fill)
          const rawLimitPrice = side.toLowerCase() === 'buy' ? price * 1.03 : price * 0.97;
          
          let limitPrice: number;
          let orderAmount: number;
          
          try {
            limitPrice = parseFloat(client.priceToPrecision(ccxtSymbol, rawLimitPrice));
            orderAmount = parseFloat(client.amountToPrecision(ccxtSymbol, amount));
          } catch (e) {
            limitPrice = Number(rawLimitPrice.toFixed(2));
            orderAmount = Number(Number(amount).toFixed(4));
          }
          
          // Final check: For buys, calculate total cost (including buffer) vs free balance
          if (side.toLowerCase() === 'buy') {
             const balance = await client.fetchBalance({ account: 'margin' });
             const usdFree = (balance as any).free?.USD || (balance as any).USD?.free || 0;
             const estimatedCost = orderAmount * limitPrice;
             if (estimatedCost > usdFree) {
               console.warn(`[TradeEdge] Insufficient Funds check: Cost $${estimatedCost} > Avail $${usdFree}. Adjusting...`);
               orderAmount = parseFloat(client.amountToPrecision(ccxtSymbol, (usdFree * 0.98) / limitPrice));
             }
          }

          console.log(`[TradeEdge GEMINI] Executing: ${side} ${orderAmount} @ ${limitPrice}`);
          order = await client.createOrder(ccxtSymbol, 'limit', side.toLowerCase(), orderAmount, limitPrice);
      } else {
          await client.loadMarkets();
          let raw = ccxtSymbol.toUpperCase().replace('/', '').replace(':', '');
          if (raw.endsWith('USD') && !raw.endsWith('USDT')) {
            raw = `${raw}T`;
          }

          const skip = unsupportedSymbolSkips.get(raw);
          if (skip && skip.until > Date.now()) {
            throw new Error(`SYMBOL SKIPPED: ${raw} temporarily blocked (${skip.reason})`);
          }

          const byId = (client as any).markets_by_id || {};
          const candidates = byId[raw] ? (Array.isArray(byId[raw]) ? byId[raw] : [byId[raw]]) : [];
          const allowedQuotes = new Set(liveFuturesQuoteAllowlist);
          const filteredCandidates = candidates.filter((m: any) => {
            const q = (m?.quote || '').toUpperCase();
            const isContract = m?.contract || m?.swap || m?.future || m?.type === 'swap';
            const hasAllowedQuote = allowedQuotes.has(q);
            const isActive = m?.active !== false;
            return isContract && hasAllowedQuote && isActive;
          });
          const resolved = filteredCandidates[0] || candidates.find((m: any) => m?.contract && m?.linear && m?.active !== false) || null;
          
          if (!resolved) {
            console.log(`[TradeEdge] Market validation failed for ${raw}: candidates=${candidates.length}, filtered=${filteredCandidates.length}, allowed_quotes=[${liveFuturesQuoteAllowlist.join(',')}]`);
          }

          if (resolved?.symbol) {
            ccxtSymbol = resolved.symbol;
          } else if (!ccxtSymbol.includes('/') && raw.endsWith('USDT')) {
            const base = raw.slice(0, -4);
            ccxtSymbol = `${base}/USDT:USDT`;
          } else {
            unsupportedSymbolSkips.set(raw, {
              count: (unsupportedSymbolSkips.get(raw)?.count || 0) + 1,
              until: Date.now() + (1000 * 60 * 3),
              reason: 'unsupported market mapping',
            });
            throw new Error(`UNSUPPORTED MARKET: ${raw} not tradable on futures quotes [${liveFuturesQuoteAllowlist.join(', ')}]`);
          }

          const marketStatus = String((resolved as any)?.info?.status || '').toUpperCase();
          if (marketStatus && marketStatus !== 'TRADING') {
            unsupportedSymbolSkips.set(raw, {
              count: (unsupportedSymbolSkips.get(raw)?.count || 0) + 1,
              until: Date.now() + (1000 * 60 * 10),
              reason: `non-trading status ${marketStatus}`,
            });
            throw new Error(`SYMBOL NOT TRADING: ${raw} status=${marketStatus}`);
          }

          const market = (client as any).markets?.[ccxtSymbol] || resolved;
          let finalAmount = Number(amount);
          if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
            throw new Error(`INVALID ORDER SIZE: ${amount}`);
          }

          const requestedPositionSide = String(positionSide || '').toUpperCase();
          const validPositionSide = requestedPositionSide === 'LONG' || requestedPositionSide === 'SHORT'
            ? requestedPositionSide
            : undefined;
          let effectivePositionSide: 'LONG' | 'SHORT' | 'BOTH' | undefined = validPositionSide;
          const wantsReduceOnly = reduceOnly === true;
          const loadReducibleExposure = async () => {
            const preferredBinance = getPreferredBinanceCredentials();
            const binanceKey = preferredBinance.key;
            const binanceSecret = preferredBinance.secret;
            if (!binanceKey || !binanceSecret) return null;

            const primary = await fetchBinancePositionsViaHttp(binanceKey, binanceSecret);
            const secondary = primary.positions.length > 0
              ? { positions: [] as any[] }
              : await fetchBinancePositionsFromAccountViaHttp(binanceKey, binanceSecret);
            const rows = [...primary.positions, ...(secondary.positions || [])];
            const matchingRows = rows.filter((row: any) => {
              const rowSymbol = String(row?.symbol || row?.info?.symbol || '')
                .toUpperCase()
                .split(':')[0]
                .replace('/', '');
              return rowSymbol === raw;
            });

            let reducibleAmount = 0;
            let reduciblePositionSide: 'LONG' | 'SHORT' | 'BOTH' | undefined;
            for (const row of matchingRows) {
              const positionAmt = Number(row?.positionAmt ?? row?.contracts ?? row?.amount ?? row?.info?.positionAmt ?? 0);
              if (!Number.isFinite(positionAmt) || positionAmt === 0) continue;
              const closesLong = side.toUpperCase() === 'SELL' && positionAmt > 0;
              const closesShort = side.toUpperCase() === 'BUY' && positionAmt < 0;
              if (!closesLong && !closesShort) continue;
              reducibleAmount += Math.abs(positionAmt);
              if (!reduciblePositionSide) {
                const rowPositionSide = String(row?.positionSide || row?.info?.positionSide || '').toUpperCase();
                reduciblePositionSide = rowPositionSide === 'LONG' || rowPositionSide === 'SHORT'
                  ? rowPositionSide
                  : 'BOTH';
              }
            }

            return reducibleAmount > 0
              ? { amount: reducibleAmount, positionSide: reduciblePositionSide }
              : null;
          };

          if (client.id === 'binance') {
            const preferredBinance = getPreferredBinanceCredentials();
            const binanceKey = preferredBinance.key;
            const binanceSecret = preferredBinance.secret;
            if (binanceKey && binanceSecret) {
              const mode = await fetchBinancePositionModeViaHttp(binanceKey, binanceSecret);
              if (mode.dualSidePosition === false) {
                // One-way mode only accepts BOTH position side.
                effectivePositionSide = 'BOTH';
              } else if (mode.dualSidePosition === true && !effectivePositionSide) {
                // In hedge mode, default to side-aligned leg if caller did not provide one.
                effectivePositionSide = side.toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';
              }
            }
          }

          if (client.id === 'binance' && wantsReduceOnly) {
            const reducibleExposure = await loadReducibleExposure();
            if (!reducibleExposure) {
              return res.json({
                status: 'skipped',
                message: `reduceOnly skipped: ${raw} no longer has reducible exposure on exchange`,
              });
            }
            if (!validPositionSide && reducibleExposure.positionSide) {
              effectivePositionSide = reducibleExposure.positionSide;
            }
            finalAmount = Math.min(finalAmount, reducibleExposure.amount);
          }

          // Precision and exchange limits precheck before submit.
          try {
            finalAmount = parseFloat(client.amountToPrecision(ccxtSymbol, finalAmount));
          } catch {
            // keep numeric fallback and let limit checks below decide
          }

          const minAmount = Number(market?.limits?.amount?.min || 0);
          const minCost = Number(market?.limits?.cost?.min || 0);
          if (Number.isFinite(minAmount) && minAmount > 0 && finalAmount < minAmount) {
            finalAmount = minAmount;
          }

          const ticker = await client.fetchTicker(ccxtSymbol);
          const last = Number(ticker?.last || ticker?.close || 0);
          const minUserNotional = Number(process.env.MIN_ORDER_NOTIONAL || 10);
          const enforcedMinNotional = wantsReduceOnly ? minCost : Math.max(minCost, minUserNotional);
          if (Number.isFinite(enforcedMinNotional) && enforcedMinNotional > 0 && Number.isFinite(last) && last > 0) {
            const cost = finalAmount * last;
            if (cost < enforcedMinNotional) {
              finalAmount = enforcedMinNotional / last;
            }
          }

          try {
            finalAmount = parseFloat(client.amountToPrecision(ccxtSymbol, finalAmount));
          } catch {
            // noop
          }

          if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
            throw new Error(`ORDER SIZE UNDERFLOW: ${ccxtSymbol} size invalid after precision/limits`);
          }

          if (!wantsReduceOnly && Number.isFinite(last) && last > 0) {
            const finalNotional = finalAmount * last;
            const minUserNotional = Number(process.env.MIN_ORDER_NOTIONAL || 10);
            if (finalNotional < minUserNotional * 0.995) {
              throw new Error(`MIN NOTIONAL ENFORCED: ${ccxtSymbol} order value $${finalNotional.toFixed(2)} is below $${minUserNotional.toFixed(2)}`);
            }

            // Conservative margin guard: cap notional to currently available balance.
            // This prevents stale UI state from submitting oversized orders that Binance rejects with -2019.
            try {
              const bal = await client.fetchBalance({ type: 'future' } as any);
              const infoRows = Array.isArray((bal as any)?.info) ? (bal as any).info : [(bal as any)?.info || {}];
              const usdtRow = infoRows.find((row: any) => (row?.asset || '').toUpperCase() === 'USDT') || infoRows[0] || {};
              const availableCandidates = [
                Number(usdtRow?.availableBalance),
                Number(usdtRow?.totalAvailableBalance),
                Number(usdtRow?.maxWithdrawAmount),
              ].filter(v => Number.isFinite(v) && v >= 0) as number[];

              const availableMargin = availableCandidates.length > 0 ? availableCandidates[0] : NaN;
              if (Number.isFinite(availableMargin)) {
                const maxNotionalAt1x = Math.max(0, availableMargin * 0.98);
                if (maxNotionalAt1x < minUserNotional) {
                  throw new Error(`allocation below available margin: available $${availableMargin.toFixed(2)} < minimum order $${minUserNotional.toFixed(2)}`);
                }
                if (finalNotional > maxNotionalAt1x) {
                  finalAmount = maxNotionalAt1x / last;
                  try {
                    finalAmount = parseFloat(client.amountToPrecision(ccxtSymbol, finalAmount));
                  } catch {
                    // Keep numeric fallback.
                  }
                  if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
                    throw new Error(`allocation below available margin: ${ccxtSymbol} size underflow after margin cap`);
                  }
                }
              }
            } catch (marginGuardErr: any) {
              const guardMsg = String(marginGuardErr?.message || 'margin guard failed');
              if (/allocation below available margin/i.test(guardMsg)) {
                throw marginGuardErr;
              }
              // If the margin probe itself fails, continue with normal exchange validation.
            }
          }

          const orderParams: Record<string, any> = {};
          if (effectivePositionSide) orderParams.positionSide = effectivePositionSide;
          if (wantsReduceOnly) orderParams.reduceOnly = true;

          const submitMarketOrder = async (params: Record<string, any>) => {
            return await client.createOrder(
              ccxtSymbol,
              'market',
              side.toLowerCase(),
              finalAmount,
              undefined,
              params
            );
          };

          const submitMarketOrderDirectHttp = async (params: Record<string, any>) => {
            const preferredBinance = getPreferredBinanceCredentials();
            const binanceKey = preferredBinance.key;
            const binanceSecret = preferredBinance.secret;
            if (!binanceKey || !binanceSecret) {
              throw new Error('Binance API keys unavailable for direct order fallback.');
            }

            const orderEndpoints = [
              'https://fapi.binance.com/fapi/v1/order',
              'https://papi.binance.com/papi/v1/um/order',
            ];

            let lastErr = 'unknown order error';
            for (let requestAttempt = 0; requestAttempt < 2; requestAttempt++) {
              const baseParams: Record<string, string> = {
                symbol: raw,
                side: String(side || '').toUpperCase(),
                type: 'MARKET',
                quantity: String(finalAmount),
                recvWindow: '5000',
              };
              if (params?.positionSide) baseParams.positionSide = String(params.positionSide);
              if (params?.reduceOnly === true) baseParams.reduceOnly = 'true';
              const { queryString, signature } = await buildBinanceSignedQuery(binanceSecret, baseParams, { forceTimeSync: requestAttempt > 0 });
              let sawTimestampError = false;

              for (const endpoint of orderEndpoints) {
                const response = await fetch(endpoint, {
                  method: 'POST',
                  headers: {
                    'X-MBX-APIKEY': binanceKey,
                    'Content-Type': 'application/x-www-form-urlencoded',
                  },
                  body: `${queryString}&signature=${signature}`,
                });

                const text = await response.text();
                if (!response.ok) {
                  lastErr = text;
                  sawTimestampError = sawTimestampError || isBinanceTimestampErrorMessage(text);
                  continue;
                }

                let json: any = {};
                try {
                  json = text ? JSON.parse(text) : {};
                } catch {
                  json = {};
                }

                binanceRouteHealth.orders = endpoint.includes('/papi/') ? 'PAPI UM' : 'FAPI';
                binanceRouteHealth.updatedAt = Date.now();

                return {
                  id: json?.orderId,
                  clientOrderId: json?.clientOrderId,
                  info: json,
                };
              }

              if (!sawTimestampError) {
                break;
              }
            }

            throw new Error(`binance ${lastErr}`);
          };

          const retryVariants: Record<string, any>[] = [];
          const pushVariant = (params: Record<string, any>) => {
            const key = JSON.stringify(params, Object.keys(params).sort());
            if (!retryVariants.some(v => JSON.stringify(v, Object.keys(v).sort()) === key)) {
              retryVariants.push(params);
            }
          };

          try {
            order = await submitMarketOrder(orderParams);
          } catch (primaryErr: any) {
            const primaryMessage = String(primaryErr?.message || '');
            const isPositionModeMismatch = /position side|hedge mode|one-way mode|dual side/i.test(primaryMessage);
            const isReduceOnlyRejected = wantsReduceOnly && /reduceonly|reduce only/i.test(primaryMessage);
            const isReduceOnlyNotRequired = /reduceonly not required|reduce-only order is rejected|parameter reduceonly/i.test(primaryMessage);

            try {
              order = await submitMarketOrderDirectHttp(orderParams);
            } catch (directErr: any) {
              const fallbackMessage = String(directErr?.message || primaryMessage);
              const fallbackPositionModeMismatch = isPositionModeMismatch || /position side|hedge mode|one-way mode|dual side/i.test(fallbackMessage);
              const fallbackReduceOnlyRejected = isReduceOnlyRejected || (wantsReduceOnly && /reduceonly|reduce only/i.test(fallbackMessage));
              const fallbackReduceOnlyNotRequired = isReduceOnlyNotRequired || /reduceonly not required|reduce-only order is rejected|parameter reduceonly/i.test(fallbackMessage);

              if (fallbackPositionModeMismatch) {
                const bothVariant = { ...orderParams, positionSide: 'BOTH' };
                pushVariant(bothVariant);
                const noSideVariant = { ...orderParams };
                delete noSideVariant.positionSide;
                pushVariant(noSideVariant);
                pushVariant({ positionSide: 'BOTH' });
                pushVariant({});
              }

              if (fallbackReduceOnlyNotRequired) {
                const noReduceVariant = { ...orderParams };
                delete noReduceVariant.reduceOnly;
                pushVariant(noReduceVariant);
              }

              if (fallbackReduceOnlyRejected && wantsReduceOnly) {
                const reducibleExposure = await loadReducibleExposure();
                if (!reducibleExposure) {
                  return res.json({
                    status: 'skipped',
                    message: `reduceOnly skipped: ${raw} exposure was already closed before retry`,
                  });
                }
                finalAmount = Math.min(finalAmount, reducibleExposure.amount);
                try {
                  finalAmount = parseFloat(client.amountToPrecision(ccxtSymbol, finalAmount));
                } catch {
                  // Keep numeric fallback.
                }
                if (!validPositionSide && reducibleExposure.positionSide) {
                  pushVariant({ ...orderParams, positionSide: reducibleExposure.positionSide, reduceOnly: true });
                }
                pushVariant({ ...orderParams, positionSide: 'BOTH', reduceOnly: true });
              }

              if (fallbackPositionModeMismatch && fallbackReduceOnlyNotRequired) {
                pushVariant({ positionSide: 'BOTH' });
                pushVariant({});
              }

              if (retryVariants.length === 0) {
                throw directErr;
              }

              let lastRetryErr: any = directErr;
              for (const retryParams of retryVariants) {
                try {
                  order = await submitMarketOrder(retryParams);
                  lastRetryErr = null;
                  break;
                } catch (retryErr: any) {
                  lastRetryErr = retryErr;
                }
              }

              if (!order) {
                for (const retryParams of retryVariants) {
                  try {
                    order = await submitMarketOrderDirectHttp(retryParams);
                    lastRetryErr = null;
                    break;
                  } catch (retryErr: any) {
                    lastRetryErr = retryErr;
                  }
                }
              }

              if (!order && lastRetryErr) {
                throw lastRetryErr;
              }
            }
          }

      
      res.json({ status: 'success', order });
    }
    } catch (error: any) {
      const msg = String(error?.message || 'Unknown order failure');
      const unsupported = msg.includes('does not have market symbol') || msg.includes('UNSUPPORTED MARKET') || msg.includes('SYMBOL SKIPPED');
      const agreementRestricted = /-4411|agreement signature is required|sign the agreement/i.test(msg);
      const lowMarginSkip = /allocation below available margin|MIN NOTIONAL ENFORCED|below minimum order/i.test(msg);

      if (lowMarginSkip) {
        const normalized = msg.toLowerCase().includes('allocation below')
          ? msg
          : `allocation below minimum order threshold: ${msg}`;
        console.warn(`[TradeEdge SKIP] ${normalized}`);
        return res.json({ status: 'skipped', message: normalized });
      }

      if (agreementRestricted) {
        const raw = String(req.body?.symbol || '').toUpperCase().replace('/', '').replace(':', '');
        if (raw) {
          unsupportedSymbolSkips.set(raw, {
            count: (unsupportedSymbolSkips.get(raw)?.count || 0) + 1,
            until: Date.now() + (1000 * 60 * 60 * 12),
            reason: 'exchange agreement required',
          });
        }
        console.warn(`[TradeEdge SKIP] agreement required: ${msg}`);
        return res.json({ status: 'skipped', message: msg });
      }

      if (unsupported) {
        const raw = String(req.body?.symbol || '').toUpperCase().replace('/', '').replace(':', '');
        if (raw) {
          unsupportedSymbolSkips.set(raw, {
            count: (unsupportedSymbolSkips.get(raw)?.count || 0) + 1,
            until: Date.now() + (1000 * 60 * 15),
            reason: 'unsupported market symbol',
          });
        }
      }
      console.error(`[TradeEdge ERROR] Order Failed: ${error.message}`);
      res.status(500).json({ status: 'error', message: error.message });
    }
  });

  app.post('/api/binance/protection', async (req, res) => {
    try {
      if (process.env.ENABLE_REAL_TRADING !== 'true') {
        throw new Error('REAL TRADING DISABLED: Set ENABLE_REAL_TRADING=true.');
      }

      const action = String(req.body?.action || 'ensure').toLowerCase();
      const symbol = String(req.body?.symbol || '').toUpperCase().replace('/', '').replace(':', '');
      const amountInput = Math.abs(Number(req.body?.amount || 0));
      const requestedPositionSide = String(req.body?.positionSide || '').toUpperCase();
      const stopPriceInput = Number(req.body?.stopPrice);
      const takeProfitPriceInput = Number(req.body?.takeProfitPrice);

      if (!symbol) {
        throw new Error('Protection request requires a symbol.');
      }
      if (isNonTradableQuoteBaseSymbol(symbol)) {
        throw new Error(`UNSUPPORTED MARKET: ${symbol} is not a tradable futures symbol.`);
      }

      const preferredBinance = getPreferredBinanceCredentials();
      const apiKey = preferredBinance.key;
      const apiSecret = preferredBinance.secret;
      if (!apiKey || !apiSecret) {
        throw new Error('Binance API keys unavailable for protection orders.');
      }

      const client = getExchange();
      await client.loadMarkets();
      const byId = (client as any).markets_by_id || {};
      const candidates = byId[symbol] ? (Array.isArray(byId[symbol]) ? byId[symbol] : [byId[symbol]]) : [];
      const allowedQuotes = new Set(liveFuturesQuoteAllowlist);
      const filteredCandidates = candidates.filter((m: any) => {
        const quote = String(m?.quote || '').toUpperCase();
        const isContract = m?.contract || m?.swap || m?.future || m?.type === 'swap';
        return isContract && allowedQuotes.has(quote) && m?.active !== false;
      });
      const resolvedMarket = filteredCandidates[0] || candidates.find((m: any) => m?.contract && m?.active !== false) || null;
      if (!resolvedMarket?.symbol) {
        throw new Error(`UNSUPPORTED MARKET: ${symbol} not tradable on configured Binance futures quotes.`);
      }

      const ccxtSymbol = String(resolvedMarket.symbol);
      const normalizeOrderAmount = (value: number) => {
        if (!Number.isFinite(value) || value <= 0) return null;
        try {
          const precise = Number(client.amountToPrecision(ccxtSymbol, value));
          return Number.isFinite(precise) && precise > 0 ? precise : value;
        } catch {
          return value;
        }
      };
      const normalizeStopPrice = (value: number) => {
        if (!Number.isFinite(value) || value <= 0) return null;
        try {
          const precise = Number(client.priceToPrecision(ccxtSymbol, value));
          return Number.isFinite(precise) && precise > 0 ? precise : value;
        } catch {
          return value;
        }
      };

      const orderEndpoints: BinanceSignedEndpoint[] = [
        { label: 'FAPI', baseUrl: 'https://fapi.binance.com', endpoint: '/fapi/v1/order' },
        { label: 'PAPI UM', baseUrl: 'https://papi.binance.com', endpoint: '/papi/v1/um/order' },
      ];
      const pmAlgoOrderEndpoints: BinanceSignedEndpoint[] = [
        { label: 'PAPI UM ALGO', baseUrl: 'https://papi.binance.com', endpoint: '/papi/v1/um/algo/order' },
      ];
      const openOrderEndpoints: BinanceSignedEndpoint[] = [
        { label: 'FAPI', baseUrl: 'https://fapi.binance.com', endpoint: '/fapi/v1/openOrders' },
        { label: 'PAPI UM', baseUrl: 'https://papi.binance.com', endpoint: '/papi/v1/um/openOrders' },
      ];

      const requestedProtectionSide = requestedPositionSide === 'LONG' || requestedPositionSide === 'SHORT' || requestedPositionSide === 'BOTH'
        ? requestedPositionSide
        : undefined;
      const protectionDirection = requestedProtectionSide === 'LONG' || requestedProtectionSide === 'SHORT'
        ? requestedProtectionSide
        : null;
      const positionMode = await fetchBinancePositionModeViaHttp(apiKey, apiSecret);
      const effectivePositionSide: 'LONG' | 'SHORT' | 'BOTH' = positionMode.dualSidePosition === true
        ? requestedProtectionSide === 'LONG' || requestedProtectionSide === 'SHORT'
          ? requestedProtectionSide
          : 'BOTH'
        : 'BOTH';
      const shouldSendPositionSide = positionMode.dualSidePosition === true && (effectivePositionSide === 'LONG' || effectivePositionSide === 'SHORT');

      const listed = await sendBinanceSignedRequest(apiKey, apiSecret, openOrderEndpoints, 'GET', { symbol, recvWindow: '5000' });
      const existingOrders = Array.isArray(listed?.data) ? listed.data : [];
      const protectiveOrders = existingOrders.filter((order: any) => {
        const type = String(order?.type || order?.origType || '').toUpperCase();
        const closePosition = String(order?.closePosition || '').toLowerCase() === 'true';
        const reduceOnly = String(order?.reduceOnly || '').toLowerCase() === 'true';
        const positionSide = String(order?.positionSide || '').toUpperCase();
        const sameSide = effectivePositionSide === 'BOTH'
          ? !positionSide || positionSide === 'BOTH'
          : !positionSide || positionSide === effectivePositionSide || positionSide === 'BOTH';
        return sameSide && (type === 'STOP_MARKET' || type === 'TAKE_PROFIT_MARKET') && (closePosition || reduceOnly);
      });

      const cancelled: Array<{ orderId: string; type: string }> = [];
      const buildProtectionClientAlgoId = (type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET') => {
        const sideToken = effectivePositionSide === 'SHORT' ? 'S' : effectivePositionSide === 'LONG' ? 'L' : 'B';
        const typeToken = type === 'STOP_MARKET' ? 'sl' : 'tp';
        return `te_${symbol}_${sideToken}_${typeToken}`.slice(0, 36);
      };
      const cancelPmAlgoOrder = async (type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET') => {
        const clientAlgoId = buildProtectionClientAlgoId(type);
        try {
          await sendBinanceSignedRequest(apiKey, apiSecret, pmAlgoOrderEndpoints, 'DELETE', {
            clientAlgoId,
            recvWindow: '5000',
          });
          cancelled.push({ orderId: clientAlgoId, type });
        } catch (error: any) {
          const message = String(error?.message || error || '');
          if (!/not found|unknown order|does not exist|order not exist/i.test(message)) {
            throw error;
          }
        }
      };
      for (const order of protectiveOrders) {
        const orderId = String(order?.orderId || order?.clientOrderId || '');
        if (!orderId) continue;
        await sendBinanceSignedRequest(apiKey, apiSecret, orderEndpoints, 'DELETE', {
          symbol,
          orderId,
          recvWindow: '5000',
        });
        cancelled.push({ orderId, type: String(order?.type || order?.origType || 'UNKNOWN') });
      }
      await cancelPmAlgoOrder('STOP_MARKET');
      await cancelPmAlgoOrder('TAKE_PROFIT_MARKET');

      if (action === 'clear') {
        return res.json({ status: 'success', action: 'clear', cancelled });
      }

      const positionSide = effectivePositionSide;
      const closeSide = protectionDirection === 'SHORT' ? 'BUY' : 'SELL';
      const protectionAmount = normalizeOrderAmount(amountInput);
      const stopPrice = normalizeStopPrice(stopPriceInput);
      const takeProfitPrice = normalizeStopPrice(takeProfitPriceInput);
      if (!stopPrice && !takeProfitPrice) {
        return res.json({ status: 'success', action: 'ensure', cancelled, armed: [] });
      }

      let currentPrice: number | null = null;
      try {
        const ticker = await client.fetchTicker(ccxtSymbol);
        const rawCurrentPrice = Number(ticker?.last || ticker?.close || ticker?.info?.markPrice || ticker?.info?.lastPrice || 0);
        currentPrice = Number.isFinite(rawCurrentPrice) && rawCurrentPrice > 0 ? rawCurrentPrice : null;
      } catch {
        currentPrice = null;
      }

      const armed: Array<{ type: string; orderId: string; stopPrice: number }> = [];
      const skipped: Array<{ type: string; stopPrice: number; reason: string }> = [];
      const isTriggerStillValid = (type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET', triggerPrice: number) => {
        if (!currentPrice) return true;
        if (protectionDirection === 'SHORT') {
          return type === 'STOP_MARKET' ? triggerPrice > currentPrice : triggerPrice < currentPrice;
        }
        return type === 'STOP_MARKET' ? triggerPrice < currentPrice : triggerPrice > currentPrice;
      };
      const placeProtectionOrder = async (type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET', triggerPrice: number) => {
        const preciseTriggerPrice = client.priceToPrecision(ccxtSymbol, triggerPrice);
        const params: Record<string, string> = {
          symbol,
          side: closeSide,
          type,
          stopPrice: preciseTriggerPrice,
          closePosition: 'true',
          workingType: 'MARK_PRICE',
          priceProtect: 'true',
          recvWindow: '5000',
        };
        if (shouldSendPositionSide) {
          params.positionSide = positionSide;
        }
        try {
          const placed = await sendBinanceSignedRequest(apiKey, apiSecret, orderEndpoints, 'POST', params);
          return placed?.data;
        } catch (error: any) {
          const message = String(error?.message || error || '');
          if (!/invalid ordertype/i.test(message)) {
            throw error;
          }
          if (!protectionAmount) {
            throw new Error(`Protection amount unavailable for ${symbol}.`);
          }
          const preciseQuantity = client.amountToPrecision(ccxtSymbol, protectionAmount);

          const algoParams: Record<string, string> = {
            algoType: 'CONDITIONAL',
            symbol,
            side: closeSide,
            type,
            quantity: preciseQuantity,
            triggerPrice: preciseTriggerPrice,
            workingType: 'MARK_PRICE',
            priceProtect: 'true',
            clientAlgoId: buildProtectionClientAlgoId(type),
            recvWindow: '5000',
          };
          if (shouldSendPositionSide) {
            algoParams.positionSide = positionSide;
          }
          if (!shouldSendPositionSide) {
            algoParams.reduceOnly = 'true';
          }
          const placed = await sendBinanceSignedRequest(apiKey, apiSecret, pmAlgoOrderEndpoints, 'POST', algoParams);
          return placed?.data;
        }
      };

      if (stopPrice) {
        if (isTriggerStillValid('STOP_MARKET', stopPrice)) {
          const placed = await placeProtectionOrder('STOP_MARKET', stopPrice);
          armed.push({ type: 'STOP_MARKET', orderId: String(placed?.orderId || placed?.clientOrderId || placed?.algoId || placed?.clientAlgoId || ''), stopPrice });
        } else {
          skipped.push({
            type: 'STOP_MARKET',
            stopPrice,
            reason: `stop already crossed current price${currentPrice ? ` ${currentPrice}` : ''}`,
          });
        }
      }
      if (takeProfitPrice) {
        if (isTriggerStillValid('TAKE_PROFIT_MARKET', takeProfitPrice)) {
          const placed = await placeProtectionOrder('TAKE_PROFIT_MARKET', takeProfitPrice);
          armed.push({ type: 'TAKE_PROFIT_MARKET', orderId: String(placed?.orderId || placed?.clientOrderId || placed?.algoId || placed?.clientAlgoId || ''), stopPrice: takeProfitPrice });
        } else {
          skipped.push({
            type: 'TAKE_PROFIT_MARKET',
            stopPrice: takeProfitPrice,
            reason: `take-profit already crossed current price${currentPrice ? ` ${currentPrice}` : ''}`,
          });
        }
      }

      if (armed.length === 0 && skipped.length > 0) {
        throw new Error(skipped.map(entry => `${entry.type} ${entry.reason}`).join(' | '));
      }

      res.json({ status: 'success', action: 'ensure', cancelled, armed, skipped, currentPrice });
    } catch (error: any) {
      console.error(`[TradeEdge ERROR] Protection Failed: ${error?.message || error}`);
      res.status(500).json({ status: 'error', message: String(error?.message || 'Protection order failure') });
    }
  });

  app.get('/api/binance/price/:symbol', async (req, res) => {
    try {
      const { symbol } = req.params;
      let target = symbol.toUpperCase();
      const source = String(req.query.source || '').toLowerCase();
      const forceBinancePublic = source === 'binance_public';

      if (forceBinancePublic) {
        recordBinanceRouteHit('public.price', `symbol=${target}`);
      }

      if (forceBinancePublic) {
        const blockedUntil = getPublicBlockedUntil();
        if (blockedUntil <= Date.now()) {
          const endpoints = [
            `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${target}`,
            `https://api.binance.com/api/v3/ticker/price?symbol=${target}`,
          ];

          for (const url of endpoints) {
            const response = await fetch(url);
            if (response.ok) {
              setPublicSourceHeaders(res, 'BINANCE_PUBLIC');
              const data: any = await response.json().catch(() => ({}));
              return res.json({ status: 'success', price: data?.price ?? null });
            }
            if (response.status === 418 || response.status === 429) {
              const body: any = await response.json().catch(() => ({}));
              const banMatch = String(body?.msg || '').match(/banned until (\d+)/);
              if (banMatch) publicRateLimitState.bannedUntil = parseInt(banMatch[1], 10);
              else publicRateLimitState.backoffUntil = Date.now() + 60000;
              break;
            }
          }
        }

        const bybitTickers = await fetchBybitTickers();
        const bybitMatch = bybitTickers.find(row => String(row.symbol || '').toUpperCase() === target);
        if (bybitMatch) {
          setPublicSourceHeaders(res, 'BYBIT_PUBLIC_FALLBACK');
          return res.json({ status: 'success', price: bybitMatch.lastPrice || null });
        }

        setPublicSourceHeaders(res, 'BINANCE_PUBLIC_FAILED');
        return res.json({ status: 'error', price: null, message: 'Public price unavailable' });
      }

      const client = getExchange();
      
      if (client.id === 'gemini') {
        // Normalize symbol for Gemini
        target = target.replace('USDT', '/USD');
        if (!target.includes('/')) {
          if (target.endsWith('USD')) target = target.replace('USD', '/USD');
          else target = `${target}/USD`;
        }
      }

      const ticker = await client.fetchTicker(target);
      res.json({ status: 'success', price: ticker.last || ticker.close });
    } catch (error: any) {
      // Fail soft for polling callers to avoid noisy 500 floods in UI.
      res.json({ status: 'error', price: null, message: error.message });
    }
  });

  // ---- Bybit public-API helpers ----
  const BYBIT_INTERVAL_MAP: Record<string, string> = {
    '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
    '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720',
    '1d': 'D', '3d': 'D', '1w': 'W', '1M': 'M',
  };

  async function fetchBybitKlines(symbol: string, interval: string, limit: number): Promise<any[] | null> {
    try {
      const bybitInterval = BYBIT_INTERVAL_MAP[interval] || 'D';
      const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitInterval}&limit=${limit}`;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const json: any = await resp.json();
      const list: any[][] = json?.result?.list;
      if (!Array.isArray(list) || list.length === 0) return null;
      // Bybit returns newest-first; reverse to match Binance oldest-first order
      return list.slice().reverse().map(c => [
        Number(c[0]),   // openTime
        c[1],           // open
        c[2],           // high
        c[3],           // low
        c[4],           // close
        c[5],           // volume
        Number(c[0]) + 60000, '0', 1, '0', '0', '0'
      ]);
    } catch {
      return null;
    }
  }

  async function fetchBybitSymbols(): Promise<{ symbol: string; status: string; baseAsset: string; quoteAsset: string; permissions: string[] }[]> {
    try {
      const resp = await fetch('https://api.bybit.com/v5/market/instruments-info?category=linear&status=Trading&limit=1000');
      if (!resp.ok) return [];
      const json: any = await resp.json();
      const list: any[] = json?.result?.list || [];
      return list.map((s: any) => ({
        symbol: String(s.symbol || '').toUpperCase(),
        status: 'TRADING',
        baseAsset: String(s.baseCoin || s.symbol?.replace('USDT','').replace('USDC','') || ''),
        quoteAsset: String(s.quoteCoin || 'USDT'),
        permissions: ['FUTURES'],
      }));
    } catch {
      return [];
    }
  }

  async function fetchBybitTickers(): Promise<{ symbol: string; lastPrice: string; quoteVolume: string }[]> {
    try {
      const resp = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
      if (!resp.ok) return [];
      const json: any = await resp.json();
      const list: any[] = json?.result?.list || [];
      return list.map((t: any) => ({
        symbol: String(t.symbol || '').toUpperCase(),
        lastPrice: String(t.lastPrice || '0'),
        quoteVolume: String(t.turnover24h || t.volume24h || '0'),
      }));
    } catch {
      return [];
    }
  }
  // ---- end Bybit helpers ----

  // Public Proxies with User-Preferred Exchange Logic
  app.get('/api/binance/proxy/klines', async (req, res) => {
    // Honour rate-limit ban window
    const now = Date.now();
    try {
      const { symbol, interval, limit } = req.query;
      const source = String(req.query.source || '').toLowerCase();
      const forceBinancePublic = source !== 'bybit';
      const usePrivateGemini = preferGemini() && hasConfiguredKeys();
      const targetSymbol = String(symbol || '').toUpperCase();
      const targetInterval = String(interval || '1d');
      const targetLimit = Math.max(1, Number(limit) || 500);
      if (forceBinancePublic) {
        recordBinanceRouteHit('public.klines', `symbol=${targetSymbol} interval=${targetInterval} limit=${targetLimit}`);
      }
      const cacheMode = forceBinancePublic ? 'binance_public' : 'hybrid';
      const cacheKey = getPublicKlineCacheKey(targetSymbol, targetInterval, targetLimit, cacheMode);
      const cacheTtlMs = getPublicKlineCacheTtlMs(targetInterval);

      if (usePrivateGemini) {
        const client = getExchange();
        // Gemini OHLCV Logic
        let geminiSymbol = String(symbol || '');
        // Gemini symbols in CCXT like BTC/USD or ETH/BTC
        // We expect incoming symbols like BTCUSD or ETHBTC
        await client.loadMarkets();
        
        // Find the market that matches the concatenated string
        const market = Object.values(client.markets).find(m => m.symbol.replace('/', '') === geminiSymbol || m.id.toUpperCase() === geminiSymbol);
        const targetSymbol = market ? market.symbol : (geminiSymbol.includes('/') ? geminiSymbol : geminiSymbol.replace('USDT', '/USD').replace('USD', '/USD'));
        
        const geminiInterval = interval === '15m' ? '15m' : interval === '1h' ? '1hr' : '1m';
        const ohlcv = await client.fetchOHLCV(targetSymbol, geminiInterval as any, undefined, Number(limit) || 100);
        const mapped = ohlcv.map(c => [c[0], c[1].toString(), c[2].toString(), c[3].toString(), c[4].toString(), c[5].toString(), c[0], "0", 1, "0", "0", "0"]);
        return res.json(mapped);
      } else {
        const freshCached = getCachedPublicKlines(cacheKey, cacheTtlMs);
        if (freshCached) {
          setPublicSourceHeaders(res, freshCached.source, true);
          return res.json(freshCached.payload);
        }

        const inflight = inflightPublicKlineRequests.get(cacheKey);
        if (inflight) {
          const shared = await inflight;
          if (shared) {
            setPublicSourceHeaders(res, shared.source, true);
            return res.json(shared.payload);
          }
        }

        if (forceBinancePublic) {
          const nowPublic = Date.now();
          const blockedUntilPublic = getPublicBlockedUntil();
          if (blockedUntilPublic > nowPublic) {
            const staleCached = getCachedPublicKlines(cacheKey, PUBLIC_KLINE_STALE_WHILE_BLOCKED_MS);
            if (staleCached) {
              setPublicSourceHeaders(res, staleCached.source, true, blockedUntilPublic);
              return res.json(staleCached.payload);
            }
            const bybitFallback = await fetchBybitKlines(targetSymbol, targetInterval, targetLimit);
            if (bybitFallback) {
              const cachedFallback = setCachedPublicKlines(cacheKey, bybitFallback, 'BYBIT_PUBLIC_FALLBACK');
              if (cachedFallback) {
                setPublicSourceHeaders(res, cachedFallback.source, true, blockedUntilPublic);
                return res.json(cachedFallback.payload);
              }
              setPublicSourceHeaders(res, 'BYBIT_PUBLIC_FALLBACK');
              return res.json(bybitFallback);
            }
            setPublicSourceHeaders(res, 'BINANCE_PUBLIC_BLOCKED', false, blockedUntilPublic);
            return res.json([]);
          }

          const fetchPromise = (async (): Promise<PublicKlineCacheEntry | null> => {
            const endpoints = [
              `https://fapi.binance.com/fapi/v1/klines?symbol=${targetSymbol}&interval=${targetInterval}&limit=${targetLimit}`,
              `https://api.binance.com/api/v3/klines?symbol=${targetSymbol}&interval=${targetInterval}&limit=${targetLimit}`,
            ];

            for (const binanceUrl of endpoints) {
              const response = await fetch(binanceUrl);
              if (response.ok) {
                const payload = await response.json();
                const cachedPayload = setCachedPublicKlines(cacheKey, payload, 'BINANCE_PUBLIC');
                if (cachedPayload) return cachedPayload;
                return Array.isArray(payload) ? { payload, updatedAt: Date.now(), source: 'BINANCE_PUBLIC' } : null;
              }
              if (response.status === 418 || response.status === 429) {
                const body: any = await response.json().catch(() => ({}));
                const banMatch = String(body?.msg || '').match(/banned until (\d+)/);
                if (banMatch) publicRateLimitState.bannedUntil = parseInt(banMatch[1], 10);
                else publicRateLimitState.backoffUntil = Date.now() + 60000;
                console.warn(`[TradeEdge RateLimit] klines Binance public source rate limited`);
                break;
              }
            }

            const bybitFallback = await fetchBybitKlines(targetSymbol, targetInterval, targetLimit);
            if (bybitFallback) {
              logWithThrottle('warn', `public-klines-fallback-${targetSymbol}`, `[TradeEdge] klines: Binance public unavailable for ${targetSymbol}, using Bybit public fallback`, 60000);
              return setCachedPublicKlines(cacheKey, bybitFallback, 'BYBIT_PUBLIC_FALLBACK') || { payload: bybitFallback, updatedAt: Date.now(), source: 'BYBIT_PUBLIC_FALLBACK' };
            }

            return null;
          })();

          inflightPublicKlineRequests.set(cacheKey, fetchPromise);
          const fetched = await fetchPromise.finally(() => inflightPublicKlineRequests.delete(cacheKey));
          if (fetched) {
            setPublicSourceHeaders(res, fetched.source);
            return res.json(fetched.payload);
          }

          setPublicSourceHeaders(res, 'BINANCE_PUBLIC_FAILED', false, getPublicBlockedUntil());
          return res.json([]);
        }

        // Try Bybit first (primary price source)
        const bybitCandles = await fetchBybitKlines(targetSymbol, targetInterval, targetLimit);
        if (bybitCandles) {
          const cachedPayload = setCachedPublicKlines(cacheKey, bybitCandles, 'BYBIT_PUBLIC_FALLBACK');
          if (cachedPayload) {
            setPublicSourceHeaders(res, cachedPayload.source, true);
            return res.json(cachedPayload.payload);
          }
          return res.json(bybitCandles);
        }

        // Bybit failed — fall back to Binance
        console.log(`[TradeEdge] klines: Bybit returned no data for ${targetSymbol}, falling back to Binance`);
        const now2 = Date.now();
        const blockedUntil2 = getPublicBlockedUntil();
        if (blockedUntil2 > now2) return res.json([]);

        const endpoints = [
          `https://fapi.binance.com/fapi/v1/klines?symbol=${targetSymbol}&interval=${targetInterval}&limit=${targetLimit}`,
          `https://api.binance.com/api/v3/klines?symbol=${targetSymbol}&interval=${targetInterval}&limit=${targetLimit}`,
        ];

        for (const binanceUrl of endpoints) {
          const response = await fetch(binanceUrl);
          if (response.ok) {
            const payload = await response.json();
            const cachedPayload = setCachedPublicKlines(cacheKey, payload, 'BINANCE_PUBLIC');
            if (cachedPayload) {
              setPublicSourceHeaders(res, cachedPayload.source, true);
              return res.json(cachedPayload.payload);
            }
            return res.json(payload);
          }
          if (response.status === 418 || response.status === 429) {
            const body: any = await response.json().catch(() => ({}));
            const banMatch = String(body?.msg || '').match(/banned until (\d+)/);
            if (banMatch) publicRateLimitState.bannedUntil = parseInt(banMatch[1], 10);
            else publicRateLimitState.backoffUntil = Date.now() + 60000;
            console.warn(`[TradeEdge RateLimit] klines Binance fallback also rate limited`);
            break;
          }
        }

        return res.json([]);
      }
    } catch (error: any) {
      // Fail soft for scanner: empty candles means "skip symbol" without UI/network error storms.
      res.json([]);
    }
  });

  app.get('/api/binance/proxy/exchangeInfo', async (req, res) => {
    try {
      const source = String(req.query.source || '').toLowerCase();
      const forceBinancePublic = source !== 'bybit';
      if (forceBinancePublic) {
        recordBinanceRouteHit('public.exchangeInfo', `spot=${String(req.query.includeSpot || '0')} futures=${String(req.query.includeFutures || '1')}`);
      }
      const usePrivateGemini = preferGemini() && hasConfiguredKeys();
      if (usePrivateGemini) {
        const client = getExchange();
        const markets = await client.loadMarkets();
        const symbols = Object.values(markets).map(m => {
          // Use m.id for value, but m.symbol for label transparency if possible
          // In CCXT, m.id is usually the exchange's ID like 'btcusd'
          const symbolStr = m.id.toUpperCase();
          return {
            symbol: symbolStr,
            status: 'TRADING', // Assume all loaded markets are tradable for maximum discovery
            baseAsset: m.base || m.symbol.split('/')[0],
            quoteAsset: m.quote || (m.symbol.includes('/') ? m.symbol.split('/')[1] : 'USD'),
            permissions: ['SPOT']
          };
        });
        return res.json({ symbols });
      } else {
        const includeSpot = String(req.query.includeSpot || '0') === '1';
        const includeFutures = String(req.query.includeFutures || '1') !== '0';
        const cacheKey = `${includeSpot ? '1' : '0'}_${includeFutures ? '1' : '0'}`;
        const cachedExchangeInfo = publicExchangeInfoCache.get(cacheKey);
        const now = Date.now();
        const blockedUntil = getPublicBlockedUntil();
        if (forceBinancePublic && blockedUntil > now) {
          if (cachedExchangeInfo?.symbols?.length) {
            logWithThrottle('warn', `exchangeInfo-cache-${cacheKey}`, `[TradeEdge] exchangeInfo: Binance public blocked, serving cached metadata (${cachedExchangeInfo.symbols.length} symbols)`, 60000);
            setPublicSourceHeaders(res, 'BINANCE_PUBLIC', true);
            return res.json({ symbols: cachedExchangeInfo.symbols, cached: true, source: 'binance_public_cache' });
          }
          return res.status(429).json({ status: 'rate_limited', symbols: [], bannedUntil: blockedUntil });
        }
        const mergedSymbols: any[] = [];

        const fetchAndCollect = async (url: string, marketType: 'spot' | 'futures') => {
          const response = await fetch(url);
          if (response.ok) {
            const data: any = await response.json();
            const symbols = Array.isArray(data?.symbols) ? data.symbols : [];
            symbols.forEach((s: any) => mergedSymbols.push({ ...s, marketType }));
            return;
          }
          if (response.status === 418 || response.status === 429) {
            const body: any = await response.json().catch(() => ({}));
            const banMatch = String(body?.msg || '').match(/banned until (\d+)/);
            if (banMatch) publicRateLimitState.bannedUntil = parseInt(banMatch[1], 10);
            else publicRateLimitState.backoffUntil = Date.now() + 60000;
            console.warn(`[TradeEdge RateLimit] exchangeInfo rate limited (${marketType}) — suppressing`);
            const newBlockedUntil = getPublicBlockedUntil();
            if (cachedExchangeInfo?.symbols?.length) {
              logWithThrottle('warn', `exchangeInfo-cache-${cacheKey}`, `[TradeEdge] exchangeInfo: Binance public rate limited, serving cached metadata (${cachedExchangeInfo.symbols.length} symbols)`, 60000);
              setPublicSourceHeaders(res, 'BINANCE_PUBLIC', true);
              res.json({ symbols: cachedExchangeInfo.symbols, cached: true, source: 'binance_public_cache' });
              return;
            }
            res.status(429).json({ status: 'rate_limited', symbols: [], bannedUntil: newBlockedUntil });
            return;
          }
          if (response.status === 451) {
            if (marketType === 'futures') {
              const fallbackSymbols = cachedExchangeInfo?.symbols?.length
                ? cachedExchangeInfo.symbols.map((symbol: any) => ({ ...symbol, marketType: symbol.marketType || 'futures' }))
                : loadFallbackFuturesExchangeInfo();
              if (fallbackSymbols.length > 0) {
                logWithThrottle('warn', 'exchangeInfo-futures-451-fallback', `[TradeEdge] exchangeInfo: Binance futures blocked by location, serving fallback futures metadata (${fallbackSymbols.length} symbols)`, 60000);
                fallbackSymbols.forEach((s: any) => mergedSymbols.push({ ...s, marketType: 'futures' }));
                return;
              }
            }
            if (marketType === 'spot') {
              logWithThrottle('warn', 'exchangeInfo-spot-451-skip', '[TradeEdge] exchangeInfo: Binance spot blocked by location, skipping spot metadata for this response', 60000);
              return;
            }
          }

          if (marketType === 'futures') {
            const fallbackSymbols = cachedExchangeInfo?.symbols?.length
              ? cachedExchangeInfo.symbols.map((symbol: any) => ({ ...symbol, marketType: symbol.marketType || 'futures' }))
              : loadFallbackFuturesExchangeInfo();
            if (fallbackSymbols.length > 0) {
              logWithThrottle(
                'warn',
                `exchangeInfo-futures-fallback-${response.status}`,
                `[TradeEdge] exchangeInfo: Binance futures request failed (${response.status}), serving fallback futures metadata (${fallbackSymbols.length} symbols)`,
                60000,
              );
              fallbackSymbols.forEach((s: any) => mergedSymbols.push({ ...s, marketType: 'futures' }));
              return;
            }
          }

          if (marketType === 'spot') {
            logWithThrottle(
              'warn',
              `exchangeInfo-spot-skip-${response.status}`,
              `[TradeEdge] exchangeInfo: Binance spot request failed (${response.status}), skipping spot metadata for this response`,
              60000,
            );
            return;
          }

          throw new Error(`Binance exchangeInfo failed (${marketType})`);
        };

        // For scan-only mode, bypass Bybit and use Binance public metadata directly.
        const bybitSymbolsPrimary = forceBinancePublic ? [] : await fetchBybitSymbols();
        const triedBybitSymbols = !forceBinancePublic;
        const deduped = new Map<string, any>();
        if (bybitSymbolsPrimary.length > 0) {
          bybitSymbolsPrimary.forEach(s => deduped.set(s.symbol, s));
        } else {
          if (triedBybitSymbols) {
            console.log('[TradeEdge] exchangeInfo: Bybit returned 0 symbols, falling back to Binance');
          }
          if (includeFutures) {
            await fetchAndCollect('https://fapi.binance.com/fapi/v1/exchangeInfo', 'futures');
            if (res.headersSent) return;
          }
          if (includeSpot) {
            await fetchAndCollect('https://api.binance.com/api/v3/exchangeInfo', 'spot');
            if (res.headersSent) return;
          }
          mergedSymbols.forEach((s: any) => {
            const key = String(s?.symbol || '').toUpperCase();
            if (!key) return;
            if (!deduped.has(key)) deduped.set(key, s);
          });
        }
        const symbols = Array.from(deduped.values());
        if (forceBinancePublic && symbols.length > 0) {
          publicExchangeInfoCache.set(cacheKey, { symbols, updatedAt: Date.now() });
          setPublicSourceHeaders(res, 'BINANCE_PUBLIC');
        } else if (bybitSymbolsPrimary.length > 0) {
          setPublicSourceHeaders(res, 'BYBIT_PUBLIC_FALLBACK');
        }
        return res.json({ symbols });
      }
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  });

  app.get('/api/binance/proxy/ticker24hr', async (req, res) => {
    try {
      const source = String(req.query.source || '').toLowerCase();
      const forceBinancePublic = source !== 'bybit';
      if (forceBinancePublic) {
        recordBinanceRouteHit('public.ticker24hr', 'source=binance_public');
      }
      const usePrivateGemini = preferGemini() && hasConfiguredKeys();
      if (usePrivateGemini) {
        const client = getExchange();
        const tickers = await client.fetchTickers();
        const mapped = Object.values(tickers).map(t => ({
          symbol: t.symbol.replace('/', ''),
          lastPrice: t.last?.toString() || '0',
          quoteVolume: t.quoteVolume?.toString() || '0',
          priceChangePercent: t.percentage?.toString() || '0'
        }));
        return res.json(mapped);
      } else {
        if (forceBinancePublic) {
          const blockedUntil = getPublicBlockedUntil();
          if (blockedUntil > Date.now()) {
            if (publicTicker24hCache?.rows?.length) {
              logWithThrottle('warn', 'ticker24hr-cache', `[TradeEdge] ticker24hr: Binance public blocked, serving cached 24h stats (${publicTicker24hCache.rows.length} rows)`, 60000);
              setPublicSourceHeaders(res, 'BINANCE_PUBLIC', true);
              return res.json(publicTicker24hCache.rows);
            }
            const bybitTickers = await fetchBybitTickers();
            if (bybitTickers.length > 0) {
              setPublicSourceHeaders(res, 'BYBIT_PUBLIC_FALLBACK');
              return res.json(bybitTickers);
            }
          }
          const url = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
          const response = await fetch(url);
          if (response.ok) {
            const rows = await response.json();
            if (Array.isArray(rows) && rows.length > 0) {
              publicTicker24hCache = { rows, updatedAt: Date.now() };
            }
            setPublicSourceHeaders(res, 'BINANCE_PUBLIC');
            return res.json(rows);
          }
          if (response.status === 418 || response.status === 429) {
            const body: any = await response.json().catch(() => ({}));
            const banMatch = String(body?.msg || '').match(/banned until (\d+)/);
            if (banMatch) publicRateLimitState.bannedUntil = parseInt(banMatch[1], 10);
            else publicRateLimitState.backoffUntil = Date.now() + 60000;
            console.warn('[TradeEdge RateLimit] ticker24hr Binance public rate limited');
          }
          const bybitTickers = await fetchBybitTickers();
          if (bybitTickers.length > 0) {
            logWithThrottle('warn', 'ticker24hr-bybit-fallback', '[TradeEdge] ticker24hr: Binance public unavailable, using Bybit public fallback', 60000);
            setPublicSourceHeaders(res, 'BYBIT_PUBLIC_FALLBACK');
            return res.json(bybitTickers);
          }
          if (publicTicker24hCache?.rows?.length) {
            setPublicSourceHeaders(res, 'BINANCE_PUBLIC', true);
            return res.json(publicTicker24hCache.rows);
          }
          throw new Error('Binance public ticker failed');
        }

        // Try Bybit first (primary ticker source)
        const bybitTickers = await fetchBybitTickers();
        if (bybitTickers.length > 0) {
          setPublicSourceHeaders(res, 'BYBIT_PUBLIC_FALLBACK');
          return res.json(bybitTickers);
        }
        // Bybit failed — fall back to Binance
        console.log('[TradeEdge] ticker24hr: Bybit returned no data, falling back to Binance');
        const url = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
        const response = await fetch(url);
        if (response.ok) {
          setPublicSourceHeaders(res, 'BINANCE_PUBLIC');
          return res.json(await response.json());
        }
        throw new Error('Both Bybit and Binance ticker failed');
      }
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[TradeEdge] Server active on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
