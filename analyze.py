import os
import json
import re

root_dir = "/Users/chetantemkar/Library/Application Support/Code/User/workspaceStorage/245cf63a4035a069327f76837d7febba/GitHub.copilot-chat/chat-session-resources/c80d0120-66f9-490b-abc0-3433ff62b68d"

events = []

for root, dirs, files in os.walk(root_dir):
    for file in files:
        if file == "content.txt":
            path = os.path.join(root, file)
            with open(path, 'r', errors='ignore') as f:
                content = f.read()
                # Find totalWalletBalance and totalUnrealizedPnl
                matches_bal = re.findall(r'"totalWalletBalance":\s*"([\d\.]+)"', content)
                matches_pnl = re.findall(r'"totalUnrealizedPnl":\s*"([-]?[\d\.]+)"', content)
                for bal in matches_bal:
                    events.append(('BALANCE', float(bal), path))
                for pnl in matches_pnl:
                    events.append(('PNL', float(pnl), path))
                
                # Find Binance Request BUY/SELL
                matches_trade = re.findall(r'Binance Request (BUY|SELL) ([A-Z0-9]+) ([\d\.]+)', content)
                for side, symbol, amount in matches_trade:
                    events.append(('TRADE', (side, symbol, float(amount)), path))

for event in sorted(events, key=lambda x: x[2]): # Sorting by path as a proxy for time
    print(event)
