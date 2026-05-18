import fs from 'fs';

const data = JSON.parse(fs.readFileSync('binance_futures.json', 'utf8'));
const symbols = data.symbols || [];

const QUOTE_ALLOWLIST = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD'];
const NON_TRADABLE_STABLE_BASES = ['USDT', 'USDC', 'BUSD', 'TUSD', 'USDP', 'FDUSD'];
const SYMBOL_REGEX = /^[A-Z0-9]{5,24}$/;

function normalizeLiveFuturesSymbol(rawSym) {
    return rawSym.replace(/(_\d{6}|_PERP)$/, "");
}

let rawCount = symbols.length;
let normalizedMap = new Map();
let invalidFormat = [];
let invalidQuote = [];
let stableBase = [];
let excludedSamples = [];

symbols.forEach(s => {
    const sym = s.symbol;
    const normalized = normalizeLiveFuturesSymbol(sym);
    const quote = s.quoteAsset;
    const base = s.baseAsset;

    let reason = null;
    if (!SYMBOL_REGEX.test(sym)) {
        reason = "invalid_format";
        invalidFormat.push(sym);
    } else if (!QUOTE_ALLOWLIST.includes(quote)) {
        reason = "invalid_quote";
        invalidQuote.push(sym);
    } else if (NON_TRADABLE_STABLE_BASES.includes(base)) {
        reason = "stable_base";
        stableBase.push(sym);
    }

    if (reason) {
        if (excludedSamples.length < 10) excludedSamples.push({sym, reason});
        return;
    }

    if (!normalizedMap.has(normalized)) {
        normalizedMap.set(normalized, sym);
    }
});

console.log(JSON.stringify({
    totalRawFutures: rawCount,
    afterDedupe: normalizedMap.size,
    excludedInvalidFormat: invalidFormat.length,
    excludedInvalidQuote: invalidQuote.length,
    excludedStableBase: stableBase.length,
    finalCandidates: normalizedMap.size,
    samples: excludedSamples
}, null, 2));
