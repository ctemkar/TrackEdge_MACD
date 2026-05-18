import json
import re

def analyze():
    try:
        with open('binance_futures.json', 'r') as f:
            data = json.load(f)
    except Exception as e:
        print(f"Error loading JSON: {e}")
        return

    symbols = data.get('symbols', [])
    raw_count = len(symbols)
    
    # Filters from src/App.tsx logic
    # invalid symbol format: /^[A-Z0-9]{5,24}$/
    # quote allowlist: USDT,USDC,FDUSD,BUSD,TUSD
    # non-tradable stable bases: USDT,USDC,BUSD,TUSD,USDP,FDUSD
    
    symbol_regex = re.compile(r'^[A-Z0-9]{5,24}$')
    quote_allowlist = {'USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD'}
    non_tradable_stable_bases = {'USDT', 'USDC', 'BUSD', 'TUSD', 'USDP', 'FDUSD'}
    
    valid_candidates = []
    invalid_format = []
    invalid_quote = []
    stable_base = []
    
    for s in symbols:
        sym = s.get('symbol', '')
        quote = s.get('quoteAsset', '')
        base = s.get('baseAsset', '')
        
        # Check format
        if not symbol_regex.match(sym):
            invalid_format.append(sym)
            continue
            
        # Check quote allowlist
        if quote not in quote_allowlist:
            invalid_quote.append(f"{sym} (quote: {quote})")
            continue
            
        # Check hasTradableBase (non-tradable stable bases)
        if base in non_tradable_stable_bases:
            stable_base.append(f"{sym} (base: {base})")
            continue
            
        valid_candidates.append(sym)
        
    print(f"Raw futures count: {raw_count}")
    print(f"Valid candidate count: {len(valid_candidates)}")
    
    print("\nTop excluded symbols per reason:")
    print(f"Invalid format (total {len(invalid_format)}): {invalid_format[:5]}")
    print(f"Invalid quote (total {len(invalid_quote)}): {invalid_quote[:5]}")
    print(f"Stable base (total {len(stable_base)}): {stable_base[:5]}")

if __name__ == '__main__':
    analyze()
