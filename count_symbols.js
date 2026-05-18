const https = require('https');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function run() {
  const spotData = await fetchJson('https://api.binance.com/api/v3/exchangeInfo');
  const futuresData = await fetchJson('https://fapi.binance.com/fapi/v1/exchangeInfo');

  const spotSymbols = spotData.symbols.filter(s => s.status === 'TRADING');
  const futuresSymbols = futuresData.symbols.filter(s => s.status === 'TRADING');

  const mergedMap = new Map();
  spotSymbols.forEach(s => mergedMap.set(s.symbol, s));
  futuresSymbols.forEach(s => mergedMap.set(s.symbol, s));
  const mergedList = Array.from(mergedMap.values());

  const stablecoins = ['USDT', 'USDC', 'BUSD', 'TUSD', 'USDP', 'FDUSD'];

  // 1. Raw merged TRADING
  const count1 = mergedList.length;

  // 2. Merged filtered by quote USDT/USDC and stable-base exclusion
  const count2 = mergedList.filter(s => 
    (s.quoteAsset === 'USDT' || s.quoteAsset === 'USDC') && 
    !stablecoins.includes(s.baseAsset)
  ).length;

  // 3. Futures-only count with USDT/USDC quotes
  const count3 = futuresSymbols.filter(s => 
    s.quoteAsset === 'USDT' || s.quoteAsset === 'USDC'
  ).length;

  // 4. Merged count with quotes USDT/USDC/FDUSD/BTC/ETH/BNB
  const extendedQuotes = ['USDT', 'USDC', 'FDUSD', 'BTC', 'ETH', 'BNB'];
  const count4 = mergedList.filter(s => extendedQuotes.includes(s.quoteAsset)).length;

  console.log('1. Raw merged TRADING symbols:', count1);
  console.log('2. Merged (USDT/USDC quote, no stable base):', count2);
  console.log('3. Futures-only (USDT/USDC quote):', count3);
  console.log('4. Merged (USDT/USDC/FDUSD/BTC/ETH/BNB quote):', count4);
}

run();
