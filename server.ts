import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import * as ccxt from 'ccxt';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  const liveQuoteAllowlist = (process.env.LIVE_QUOTE_ALLOWLIST || 'USDT,FDUSD,USDC,BUSD,TUSD,BTC,ETH,BNB')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
  const unsupportedSymbolSkips = new Map<string, { until: number; count: number; reason: string }>();

  app.use(cors());
  app.use(express.json());

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
  const preferGemini = () => (process.env.EXCHANGE || '').toLowerCase() === 'gemini';
  const getExchange = () => {
    if (!exchangeInstance) {
      const bKey = (process.env.BINANCE_LIVE_API_KEY || process.env.BINANCE_API_KEY || process.env.BINANCE_KEY || '').trim();
      const bSecret = (process.env.BINANCE_LIVE_API_SECRET || process.env.BINANCE_API_SECRET || process.env.BINANCE_SECRET || '').trim();
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
         console.warn(`[TradeEdge] Initializing BINANCE client (Key: ${apiKey.substring(0, 8)}...)`);
         exchangeInstance = new ccxt.binance({
           apiKey,
           secret,
           enableRateLimit: true,
           options: { 
             defaultType: 'future',
              adjustForTimeDifference: true,
              portfolioMargin: true
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

  app.get('/api/binance/balance', async (req, res) => {
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
      const allPositions: Record<string, { amount: number, total: number, side?: 'LONG' | 'SHORT', entryPrice?: number, unrealizedPnl?: number }> = {};

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

      if (client.id === 'binance') {
        const upsertPosition = (input: any) => {
          const rawAmt = Number(input?.contracts ?? input?.positionAmt ?? input?.info?.positionAmt ?? 0);
          const contracts = Math.abs(rawAmt);
          if (!Number.isFinite(contracts) || contracts <= 0) return;

          const sideRaw = String(input?.side || input?.positionSide || input?.info?.positionSide || '').toUpperCase();
          const inferredSide: 'LONG' | 'SHORT' = sideRaw === 'SHORT' || rawAmt < 0 ? 'SHORT' : 'LONG';
          const entry = Number(input?.entryPrice ?? input?.info?.entryPrice ?? 0);
          const unrealized = Number(input?.unrealizedPnl ?? input?.unRealizedProfit ?? input?.info?.unRealizedProfit ?? 0);

          const symbolRaw = String(input?.symbol || input?.info?.symbol || '').toUpperCase();
          if (!symbolRaw) return;
          const compact = symbolRaw.replace('/', '').replace(':USDT', '').replace(':USD', '').replace(':', '');
          const normalized = compact.endsWith('USDT') || compact.endsWith('USD') ? compact : `${compact}USDT`;

          allPositions[normalized] = {
            amount: contracts,
            total: contracts,
            side: inferredSide,
            entryPrice: Number.isFinite(entry) && entry > 0 ? entry : undefined,
            unrealizedPnl: Number.isFinite(unrealized) ? unrealized : undefined,
          };
        };

        try {
          const fetchedPositions = await (client as any).fetchPositions?.(undefined, { type: 'future' });
          if (Array.isArray(fetchedPositions)) {
            fetchedPositions.forEach(upsertPosition);
          }
        } catch (e: any) {
          console.warn(`[TradeEdge Sync] fetchPositions failed: ${e?.message || 'unknown error'}`);
        }

        const positionRiskFetchers = [
          async () => await (client as any).fapiPrivateV2GetPositionRisk?.(),
          async () => await (client as any).fapiPrivateGetPositionRisk?.(),
          async () => await (client as any).papiGetUmPositionRisk?.(),
        ];

        for (const fetcher of positionRiskFetchers) {
          try {
            const rows = await fetcher();
            if (Array.isArray(rows) && rows.length > 0) {
              rows.forEach(upsertPosition);
              break;
            }
          } catch {
            // Try the next position endpoint variant.
          }
        }

        totalUnrealizedPnl = Object.values(allPositions).reduce((sum, p) => {
          const u = Number((p as any)?.unrealizedPnl);
          return Number.isFinite(u) ? sum + u : sum;
        }, 0);
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
          // PM APIs can report a very low available value while account equity is high.
          // If we are flat (or nearly flat) and the value is implausibly small, show fallback cash/equity.
          if (!hasOpenPositions && fallbackCash > 0 && primaryAvailable < fallbackCash * 0.1) {
            uiAvailableBalance = fallbackCash;
          } else {
            uiAvailableBalance = primaryAvailable;
          }
        } else {
          uiAvailableBalance = fallbackCash;
        }
      }

      if (uiAvailableBalance === null) {
        uiAvailableBalance = cashTotal;
      }
      
      console.log(`[TradeEdge Sync] ${client.id.toUpperCase()} Summary: Cash=$${cashTotal}, Valid Positions=${Object.keys(allPositions).join(',')}`);
      
      res.json({ 
        status: 'success', 
        exchange: client.id, 
        account: client.id === 'gemini' ? (params.account || 'Primary') : 'Standard',
        balance: { USDT: cashTotal }, 
        equity: portfolioMarginEquity,
        availableBalance: uiAvailableBalance,
        unrealizedPnl: totalUnrealizedPnl,
        positions: allPositions,
        raw: process.env.NODE_ENV === 'development' ? { info: balanceData.info } : undefined
      });
    } catch (error: any) {
      console.error(`[TradeEdge Sync Error] ${error.message}`);
      res.status(500).json({ status: 'error', message: error.message });
    }
  });

  app.post('/api/binance/order', async (req, res) => {
    try {
      if (process.env.ENABLE_REAL_TRADING !== 'true') {
        throw new Error('REAL TRADING DISABLED: Set ENABLE_REAL_TRADING=true.');
      }

      const { symbol, side, amount } = req.body;
      const client = getExchange();
      
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
          const allowedQuotes = new Set(liveQuoteAllowlist);
          const filteredCandidates = candidates.filter((m: any) => {
            const q = (m?.quote || '').toUpperCase();
            const isContract = m?.contract || m?.swap || m?.future || m?.type === 'swap';
            const hasAllowedQuote = allowedQuotes.has(q);
            const isActive = m?.active !== false;
            return isContract && hasAllowedQuote && isActive;
          });
          const resolved = filteredCandidates[0] || candidates.find((m: any) => m?.contract && m?.linear && m?.active !== false) || null;
          
          if (!resolved) {
            console.log(`[TradeEdge] Market validation failed for ${raw}: candidates=${candidates.length}, filtered=${filteredCandidates.length}, allowed_quotes=[${liveQuoteAllowlist.join(',')}]`);
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
            throw new Error(`UNSUPPORTED MARKET: ${raw} not tradable on allowed quotes [${liveQuoteAllowlist.join(', ')}]`);
          }

          const market = (client as any).markets?.[ccxtSymbol] || resolved;
          let finalAmount = Number(amount);
          if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
            throw new Error(`INVALID ORDER SIZE: ${amount}`);
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
          if (Number.isFinite(minCost) && minCost > 0 && Number.isFinite(last) && last > 0) {
            const cost = finalAmount * last;
            if (cost < minCost) {
              finalAmount = minCost / last;
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

          order = await client.createMarketOrder(
            ccxtSymbol, 
            side.toLowerCase(), 
            finalAmount
          );
      }
      
      res.json({ status: 'success', order });
    } catch (error: any) {
      const msg = String(error?.message || 'Unknown order failure');
      const unsupported = msg.includes('does not have market symbol') || msg.includes('UNSUPPORTED MARKET') || msg.includes('SYMBOL SKIPPED');
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
      res.status(500).json({ status: 'error', message: error.message });
    }
  });

  // Public Proxies with User-Preferred Exchange Logic
  app.get('/api/binance/proxy/klines', async (req, res) => {
    try {
      const { symbol, interval, limit } = req.query;
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
        // Binance default
        const binanceUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const response = await fetch(binanceUrl);
        if (response.ok) return res.json(await response.json());
        throw new Error('Binance fetch failed');
      }
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  });

  app.get('/api/binance/proxy/exchangeInfo', async (req, res) => {
    try {
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
        const url = 'https://api.binance.com/api/v3/exchangeInfo';
        const response = await fetch(url);
        if (response.ok) return res.json(await response.json());
        throw new Error('Binance exchangeInfo failed');
      }
    } catch (error: any) {
      res.status(500).json({ status: 'error', message: error.message });
    }
  });

  app.get('/api/binance/proxy/ticker24hr', async (req, res) => {
    try {
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
        const url = 'https://api.binance.com/api/v3/ticker/24hr';
        const response = await fetch(url);
        if (response.ok) return res.json(await response.json());
        throw new Error('Binance ticker failed');
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
