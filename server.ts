import express from 'express';
import path from 'path';
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

  // Rate-limit state: tracks when Binance bans expire + consecutive failure count for backoff
  const rateLimitState = {
    bannedUntil: 0,       // epoch ms when Binance IP ban expires
    failCount: 0,         // consecutive sync failures
    backoffUntil: 0,      // epoch ms to suppress retries during backoff
    authFailCount: 0,     // consecutive Binance auth/permission failures
    authBlockedUntil: 0,  // epoch ms to suppress retries for invalid keys/permissions
  };
  const MAX_BACKOFF_MS = 5 * 60 * 1000; // cap backoff at 5 minutes
  const MAX_AUTH_BLOCK_MS = 10 * 60 * 1000; // cap auth block at 10 minutes
  const throttledLogState = new Map<string, number>();
  const logOnceState = new Set<string>();

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
      const timestamp = Date.now();
      const params = new URLSearchParams({ timestamp: String(timestamp) });
      const queryString = params.toString();
      
      const signature = crypto
        .createHmac('sha256', apiSecret)
        .update(queryString)
        .digest('hex');

      const endpoints = [
        { label: 'fapi-position-risk', url: `https://fapi.binance.com/fapi/v2/positionRisk?${queryString}&signature=${signature}` },
        { label: 'papi-um-position-risk', url: `https://papi.binance.com/papi/v1/um/positionRisk?${queryString}&signature=${signature}` },
      ];

      let sawAuthError = false;
      let lastMessage = '';
      const endpointErrors: string[] = [];

      for (const endpoint of endpoints) {
        const response = await fetch(endpoint.url, {
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
          endpointErrors.push(`${endpoint.label}:${response.status}:${text.substring(0, 100)}`);
          continue;
        }

        const data = await response.json();
        if (Array.isArray(data)) {
          binanceRouteHealth.positions = endpoint.label === 'papi-um-position-risk' ? 'PAPI UM' : 'FAPI';
          binanceRouteHealth.updatedAt = Date.now();
          console.log(`[TradeEdge] Direct Binance HTTP: Got ${data.length} positions from ${endpoint.label}`);
          return { positions: data, authError: false };
        }
      }

      if (endpointErrors.length > 0) {
        const msg = endpointErrors.slice(0, 2).join(' | ');
        const level = sawAuthError ? 'warn' : 'log';
        logOnce(
          level,
          `binance-position-risk-all-failed-${sawAuthError ? 'auth' : 'other'}`,
          `[TradeEdge] Binance positionRisk fallback exhausted: ${msg}`,
        );
      }

      return { positions: [], authError: sawAuthError, message: lastMessage || 'positionRisk unavailable' };
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
      const timestamp = Date.now();
      const params = new URLSearchParams({ timestamp: String(timestamp) });
      const queryString = params.toString();
      const signature = crypto
        .createHmac('sha256', apiSecret)
        .update(queryString)
        .digest('hex');

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

      return { ok: response.ok, status: response.status, text, data };
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

      const timestamp = Date.now();
      const recvWindow = '5000';
      const params = new URLSearchParams({ timestamp: String(timestamp), recvWindow });
      const queryString = params.toString();
      const signature = crypto
        .createHmac('sha256', apiSecret)
        .update(queryString)
        .digest('hex');

      const endpoints = [
        'https://fapi.binance.com/fapi/v1/positionSide/dual',
        'https://papi.binance.com/papi/v1/um/positionSide/dual',
      ];

      for (const endpoint of endpoints) {
        const url = `${endpoint}?${queryString}&signature=${signature}`;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'X-MBX-APIKEY': apiKey,
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) continue;

        const json: any = await response.json();
        const raw = json?.dualSidePosition;
        const dualSidePosition = typeof raw === 'boolean' ? raw : String(raw || '').toLowerCase() === 'true';

        cachedBinancePositionMode = {
          dualSidePosition,
          fetchedAt: Date.now(),
        };
        return { dualSidePosition };
      }

      return { dualSidePosition: null };
    } catch {
      return { dualSidePosition: null };
    }
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
    const blockedUntil = Math.max(rateLimitState.bannedUntil, rateLimitState.backoffUntil);
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
      blockedUntil: blockedUntil > now ? blockedUntil : 0,
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
      const timestamp = Date.now();
      const recvWindow = 5000;
      const params = new URLSearchParams({
        type,
        asset,
        amount: amount.toString(),
        timestamp: String(timestamp),
        recvWindow: String(recvWindow),
      });
      const queryString = params.toString();
      const signature = crypto
        .createHmac('sha256', apiSecret)
        .update(queryString)
        .digest('hex');

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
    if (rateLimitState.authBlockedUntil > now) {
      const waitSec = Math.ceil((rateLimitState.authBlockedUntil - now) / 1000);
      return res.status(401).json({
        status: 'auth_failed',
        retryAfterMs: rateLimitState.authBlockedUntil - now,
        blockedUntil: rateLimitState.authBlockedUntil,
        message: `Binance Futures API auth/permissions failed. Retry in ${waitSec}s after fixing API key permissions.`,
      });
    }

    const blockedUntil = Math.max(rateLimitState.bannedUntil, rateLimitState.backoffUntil);
    if (blockedUntil > now) {
      const waitSec = Math.ceil((blockedUntil - now) / 1000);
      console.warn(`[TradeEdge RateLimit] Sync suppressed — ${waitSec}s remaining (bannedUntil=${new Date(rateLimitState.bannedUntil).toISOString()})`);
      return res.status(429).json({ status: 'rate_limited', retryAfterMs: blockedUntil - now, message: `Rate limited. Retry in ${waitSec}s.` });
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
      let papiActualEquity: number | null = null;
      let papiAvailableBalance: number | null = null;
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
        } catch (e) {
          console.warn(`[TradeEdge Sync] ${client.id} targeting ${params.account || 'default'} failed, fallback to default account.`);
          balanceData = await client.fetchBalance({});
        }

        try {
          const papiAccount = await (client as any).papiGetAccount?.();
          if (papiAccount) {
            const actual = Number(papiAccount.actualEquity || papiAccount.accountEquity);
            const available = Number(papiAccount.totalAvailableBalance || papiAccount.virtualMaxWithdrawAmount);
            if (Number.isFinite(actual) && actual > 0) papiActualEquity = actual;
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
          logWithThrottle(
            'log',
            'sync-direct-http-attempt-debug',
            `[TradeEdge Sync DEBUG] Direct HTTP attempt: got ${httpPositions.length} positions, authError=${httpPositionResult.authError}${httpPositionResult.message ? `, message=${httpPositionResult.message}` : ''}`,
            60 * 1000,
          );
          if (httpPositions.length > 0) {
            console.log(`[TradeEdge Sync] Successfully fetched ${httpPositions.length} positions via direct HTTP API`);
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
              logWithThrottle(
                'log',
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
        logWithThrottle(
          'log',
          'sync-total-unrealized-pnl-debug',
          `[TradeEdge Sync DEBUG] totalUnrealizedPnl from positions: ${totalUnrealizedPnl}`,
          60 * 1000,
        );

        // ALSO add UM unrealized PnL from the account info (UM = Unified Margin positions in futures)
        if (Array.isArray(b.info) && totalUnrealizedPnl === 0) {
          const umPnlSum = b.info.reduce((sum: number, row: any) => {
            const umPnl = Number(row?.umUnrealizedPNL || 0);
            if (Number.isFinite(umPnl) && umPnl !== 0) {
              logWithThrottle(
                'log',
                `sync-um-asset-pnl-${row.asset}`,
                `[TradeEdge Sync DEBUG] ${row.asset}: umUnrealizedPNL=${umPnl}`,
                5 * 60 * 1000,
              );
            }
            return sum + (Number.isFinite(umPnl) ? umPnl : 0);
          }, 0);
          logWithThrottle(
            'log',
            'sync-um-pnl-sum-debug',
            `[TradeEdge Sync DEBUG] umPnlSum from info array: ${umPnlSum}`,
            60 * 1000,
          );
          if (umPnlSum !== 0) {
            totalUnrealizedPnl = umPnlSum;
            logWithThrottle(
              'log',
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
          papiActualEquity,
          Number(info.totalWalletBalance),
          Number(info.totalMarginBalance),
          Number(info.totalCrossWalletBalance),
          Number(info.totalInitialMargin),
          Number(info.totalAvailableBalance),
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

        if (portfolioMarginEquity && portfolioMarginEquity > cashTotal) {
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
      
      res.json({ 
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
      });
      // Successful sync — reset failure counter
      rateLimitState.failCount = 0;
      rateLimitState.backoffUntil = 0;
      rateLimitState.authFailCount = 0;
      rateLimitState.authBlockedUntil = 0;
    } catch (error: any) {
      const msg = String(error?.message || '');
      const statusCode = Number(error?.status || error?.httpCode || 0);

      if (isBinanceAuthErrorMessage(msg)) {
        rateLimitState.authFailCount += 1;
        const blockMs = Math.min(rateLimitState.authFailCount * 2 * 60 * 1000, MAX_AUTH_BLOCK_MS);
        rateLimitState.authBlockedUntil = Date.now() + blockMs;
        return res.status(401).json({
          status: 'auth_failed',
          message: msg,
          blockedUntil: rateLimitState.authBlockedUntil,
          retryAfterMs: blockMs,
        });
      }

      // Detect 418 (IP ban) or 429 (rate limit) from Binance
      if (statusCode === 418 || statusCode === 429 || msg.includes('banned until') || msg.includes('Too many requests')) {
        // Parse the 'banned until' timestamp from the error message if present
        const banMatch = msg.match(/banned until (\d+)/);
        if (banMatch) {
          rateLimitState.bannedUntil = parseInt(banMatch[1], 10);
          console.error(`[TradeEdge RateLimit] IP ban detected — suppressing sync until ${new Date(rateLimitState.bannedUntil).toISOString()}`);
        } else {
          // No explicit ban time — apply exponential backoff
          rateLimitState.failCount++;
          const backoffMs = Math.min(Math.pow(2, rateLimitState.failCount) * 5000, MAX_BACKOFF_MS);
          rateLimitState.backoffUntil = Date.now() + backoffMs;
          console.error(`[TradeEdge RateLimit] Rate limited (attempt ${rateLimitState.failCount}) — backing off ${backoffMs / 1000}s`);
        }
        res.status(429).json({ status: 'rate_limited', message: msg, bannedUntil: rateLimitState.bannedUntil || rateLimitState.backoffUntil });
      } else {
        // Generic error — apply small backoff on repeated failures
        rateLimitState.failCount++;
        if (rateLimitState.failCount > 3) {
          const backoffMs = Math.min(rateLimitState.failCount * 10000, MAX_BACKOFF_MS);
          rateLimitState.backoffUntil = Date.now() + backoffMs;
          console.warn(`[TradeEdge Sync] ${rateLimitState.failCount} consecutive failures — backing off ${backoffMs / 1000}s`);
        }
        console.error(`[TradeEdge Sync Error] ${msg}`);
        res.status(500).json({ status: 'error', message: msg });
      }
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

            const timestamp = Date.now();
            const body = new URLSearchParams({
              symbol: raw,
              side: String(side || '').toUpperCase(),
              type: 'MARKET',
              quantity: String(finalAmount),
              recvWindow: '5000',
              timestamp: String(timestamp),
            });

            if (params?.positionSide) body.set('positionSide', String(params.positionSide));
            if (params?.reduceOnly === true) body.set('reduceOnly', 'true');

            const query = body.toString();
            const signature = crypto.createHmac('sha256', binanceSecret).update(query).digest('hex');
            const orderEndpoints = [
              'https://fapi.binance.com/fapi/v1/order',
              'https://papi.binance.com/papi/v1/um/order',
            ];

            let lastErr = 'unknown order error';
            for (const endpoint of orderEndpoints) {
              const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                  'X-MBX-APIKEY': binanceKey,
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: `${query}&signature=${signature}`,
              });

              const text = await response.text();
              if (!response.ok) {
                lastErr = text;
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

            throw new Error(`binance ${lastErr}`);
          };

          try {
            order = await submitMarketOrder(orderParams);
          } catch (primaryErr: any) {
            const primaryMsg = String(primaryErr?.message || '');
            const isPositionModeMismatch = /position side does not match|positionSide|hedge mode|\b-4061\b|\"code\":-4061/i.test(primaryMsg);
            const isReduceOnlyNotRequired = /reduceOnly.+not required|Parameter 'reduceOnly' sent when not required|\"code\":-1106/i.test(primaryMsg);

            const retryVariants: Record<string, any>[] = [];
            const pushVariant = (params: Record<string, any>) => {
              const key = JSON.stringify(params, Object.keys(params).sort());
              if (!retryVariants.some(v => JSON.stringify(v, Object.keys(v).sort()) === key)) {
                retryVariants.push(params);
              }
            };

            if (isPositionModeMismatch) {
              // Try BOTH for one-way accounts first, then omit positionSide entirely.
              const bothVariant = { ...orderParams, positionSide: 'BOTH' };
              pushVariant(bothVariant);
              const noSideVariant = { ...orderParams };
              delete noSideVariant.positionSide;
              pushVariant(noSideVariant);

              // Strict fallbacks: remove optional flags that can conflict with account mode.
              pushVariant({ positionSide: 'BOTH' });
              pushVariant({});
            }

            if (isReduceOnlyNotRequired) {
              const noReduceVariant = { ...orderParams };
              delete noReduceVariant.reduceOnly;
              pushVariant(noReduceVariant);
            }

            // Combined fallback: same strict variants should be re-tried if both errors occur together.
            if (isPositionModeMismatch && isReduceOnlyNotRequired) {
              pushVariant({ positionSide: 'BOTH' });
              pushVariant({});
            }

            if (retryVariants.length === 0) {
              throw primaryErr;
            }

            let lastRetryErr: any = primaryErr;
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
    } catch (error: any) {
      const msg = String(error?.message || 'Unknown order failure');
      const unsupported = msg.includes('does not have market symbol') || msg.includes('UNSUPPORTED MARKET') || msg.includes('SYMBOL SKIPPED');
      const lowMarginSkip = /allocation below available margin|MIN NOTIONAL ENFORCED|below minimum order/i.test(msg);

      if (lowMarginSkip) {
        const normalized = msg.toLowerCase().includes('allocation below')
          ? msg
          : `allocation below minimum order threshold: ${msg}`;
        console.warn(`[TradeEdge SKIP] ${normalized}`);
        return res.json({ status: 'skipped', message: normalized });
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

  app.get('/api/binance/price/:symbol', async (req, res) => {
    try {
      const { symbol } = req.params;
      const client = getExchange();
      let target = symbol.toUpperCase();
      
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
    const blockedUntil = Math.max(rateLimitState.bannedUntil, rateLimitState.backoffUntil);
    if (blockedUntil > now) {
      return res.json([]); // return empty candles so scanner skips quietly
    }
    try {
      const { symbol, interval, limit } = req.query;
      const source = String(req.query.source || '').toLowerCase();
      const forceBinancePublic = source !== 'bybit';
      const usePrivateGemini = preferGemini() && hasConfiguredKeys();

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
        if (forceBinancePublic) {
          const nowPublic = Date.now();
          const blockedUntilPublic = Math.max(rateLimitState.bannedUntil, rateLimitState.backoffUntil);
          if (blockedUntilPublic > nowPublic) return res.json([]);

          const endpoints = [
            `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
            `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
          ];

          for (const binanceUrl of endpoints) {
            const response = await fetch(binanceUrl);
            if (response.ok) return res.json(await response.json());
            if (response.status === 418 || response.status === 429) {
              const body: any = await response.json().catch(() => ({}));
              const banMatch = String(body?.msg || '').match(/banned until (\d+)/);
              if (banMatch) rateLimitState.bannedUntil = parseInt(banMatch[1], 10);
              else rateLimitState.backoffUntil = Date.now() + 60000;
              console.warn(`[TradeEdge RateLimit] klines Binance public source rate limited`);
              break;
            }
          }

          return res.json([]);
        }

        // Try Bybit first (primary price source)
        const bybitCandles = await fetchBybitKlines(String(symbol), String(interval || '1d'), Number(limit) || 500);
        if (bybitCandles) {
          return res.json(bybitCandles);
        }

        // Bybit failed — fall back to Binance
        console.log(`[TradeEdge] klines: Bybit returned no data for ${symbol}, falling back to Binance`);
        const now2 = Date.now();
        const blockedUntil2 = Math.max(rateLimitState.bannedUntil, rateLimitState.backoffUntil);
        if (blockedUntil2 > now2) return res.json([]);

        const endpoints = [
          `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
          `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
        ];

        for (const binanceUrl of endpoints) {
          const response = await fetch(binanceUrl);
          if (response.ok) return res.json(await response.json());
          if (response.status === 418 || response.status === 429) {
            const body: any = await response.json().catch(() => ({}));
            const banMatch = String(body?.msg || '').match(/banned until (\d+)/);
            if (banMatch) rateLimitState.bannedUntil = parseInt(banMatch[1], 10);
            else rateLimitState.backoffUntil = Date.now() + 60000;
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
    // Honour rate-limit ban window
    const now = Date.now();
    const blockedUntil = Math.max(rateLimitState.bannedUntil, rateLimitState.backoffUntil);
    if (blockedUntil > now) {
      return res.status(429).json({ status: 'rate_limited', symbols: [], bannedUntil: blockedUntil });
    }
    try {
      const source = String(req.query.source || '').toLowerCase();
      const forceBinancePublic = source !== 'bybit';
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
            if (banMatch) rateLimitState.bannedUntil = parseInt(banMatch[1], 10);
            else rateLimitState.backoffUntil = Date.now() + 60000;
            console.warn(`[TradeEdge RateLimit] exchangeInfo rate limited (${marketType}) — suppressing`);
            const newBlockedUntil = Math.max(rateLimitState.bannedUntil, rateLimitState.backoffUntil);
            res.status(429).json({ status: 'rate_limited', symbols: [], bannedUntil: newBlockedUntil });
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

        return res.json({ symbols: Array.from(deduped.values()) });
      }
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  });

  app.get('/api/binance/proxy/ticker24hr', async (req, res) => {
    try {
      const source = String(req.query.source || '').toLowerCase();
      const forceBinancePublic = source !== 'bybit';
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
          const url = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
          const response = await fetch(url);
          if (response.ok) return res.json(await response.json());
          throw new Error('Binance public ticker failed');
        }

        // Try Bybit first (primary ticker source)
        const bybitTickers = await fetchBybitTickers();
        if (bybitTickers.length > 0) return res.json(bybitTickers);
        // Bybit failed — fall back to Binance
        console.log('[TradeEdge] ticker24hr: Bybit returned no data, falling back to Binance');
        const url = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
        const response = await fetch(url);
        if (response.ok) return res.json(await response.json());
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
