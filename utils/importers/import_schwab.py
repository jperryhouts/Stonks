#!/usr/bin/env python3
"""Conversion of Schwab brokerage JSON exports to trades.json

Supports two Schwab export formats:
  - Brokerage Transaction History (BrokerageTransactions key)
  - Equity Awards Center (Transactions key)

Usage:
    1. Download Transaction History from Schwab:
        Brokerage accounts:
          - Navigate to an account's Transaction History
          - Set the Date Range (can be up to four-year window) and click "Search"
          - Click the "download" icon in the top right (next to the printer icon)
          - Save as JSON format
    2. Run the script:
        `python3 utils/importers/import_schwab.py [/path/to/file.json ...] > _tmp_trades.json`
    3. Manually copy from _tmp_trades.json into your `data/trades.json`.

Note: This script was written as a one-off for importing lots of historical trades.
It's simple and works for one-off imports, but not really designed for automation
workflows. That said, it's not a complex script, so if automatic importing is desirable
this could easily be extended and hardened to support that. You'd want to add some
capability to avoid duplicating trades, and automatic merging into the existing
trades.json.
"""

import json, sys
from datetime import datetime

def clean_num(s):
    return s.strip().lstrip('$').replace(',', '') if s else ''

def iso(s):
    # Dates may have " as of MM/DD/YYYY" suffix; take the first part
    return datetime.strptime(s.strip().split()[0], '%m/%d/%Y').strftime('%Y-%m-%d')

files = sys.argv[1:]

if not files:
    print("At least one Schwab data export file must be specified.")
    sys.exit(1)

trades = []
for path in files:
    data = json.load(open(path))

    if 'BrokerageTransactions' in data:
        for t in data['BrokerageTransactions']:
            action = t['Action']
            symbol = t['Symbol'].strip()
            if not symbol:
                continue

            if action == 'Buy':
                trades.append({
                    'date': iso(t['Date']),
                    'symbol': symbol,
                    'price': str(round(float(clean_num(t['Price'])), 6)),
                    'quantity': str(float(clean_num(t['Quantity']))),
                    'type': 'buy',
                })

            elif action == 'Reinvest Shares':
                trades.append({
                    'date': iso(t['Date']),
                    'symbol': symbol,
                    'price': str(round(float(clean_num(t['Price'])), 6)),
                    'quantity': str(float(clean_num(t['Quantity']))),
                    'type': 'drip',
                    'note': 'reinvested dividend',
                })

            elif action == 'Sell':
                trades.append({
                    'date': iso(t['Date']),
                    'symbol': symbol,
                    'price': str(round(float(clean_num(t['Price'])), 6)),
                    'quantity': str(abs(float(clean_num(t['Quantity'])))),
                    'type': 'sell',
                })
            # Journaled Shares and everything else = skip

    elif 'Transactions' in data:
        for t in data['Transactions']:
            action = t['Action']
            symbol = (t.get('Symbol') or '').strip()
            if not symbol:
                continue
            date = iso(t['Date'])
            details = (t.get('TransactionDetails') or [{}])[0].get('Details', {})

            if action == 'Lapse':
                # RSU vest: the full vested quantity is acquired at FMV.
                # (SharesSoldWithheldForTaxes shares will appear as a Sale later.)
                qty = float(clean_num(t['Quantity']))
                price = float(clean_num(details.get('FairMarketValuePrice', '')))
                trades.append({
                    'date': date,
                    'symbol': symbol,
                    'price': str(round(price, 6)),
                    'quantity': str(qty),
                    'type': 'buy',
                    'note': f"RSU vest (grant {details.get('AwardId', '')})",
                })

            elif action == 'Deposit' and t.get('Description') == 'ESPP':
                # ESPP purchase: shares deposited at the discounted purchase price.
                qty = float(clean_num(t['Quantity']))
                price = float(clean_num(details.get('PurchasePrice', '')))
                trades.append({
                    'date': date,
                    'symbol': symbol,
                    'price': str(round(price, 6)),
                    'quantity': str(qty),
                    'type': 'buy',
                    'note': 'ESPP purchase',
                })
            # Deposit Description="RS" = net shares after tax withholding;
            # redundant with Lapse records above, so skip.

            elif action == 'Sale':
                # Share sale (includes tax-withholding "sell to cover" sales).
                # Use per-lot SalePrice from the first lot (all lots in a single
                # market order share the same price). Fall back to Amount/Quantity.
                qty = float(clean_num(t['Quantity']))
                if details.get('SalePrice'):
                    price = float(clean_num(details['SalePrice']))
                else:
                    price = float(clean_num(t['Amount'])) / qty
                trades.append({
                    'date': date,
                    'symbol': symbol,
                    'price': str(round(price, 6)),
                    'quantity': str(abs(qty)),
                    'type': 'sell',
                })
            # Journal, Dividend, Check = skip

    else:
        print(f"Warning: unrecognized format in {path}", file=sys.stderr)

trades.sort(key=lambda r: (r['date'], r['symbol'], r['type'], r['quantity']), reverse=True)
print("  " + ",\n  ".join(json.dumps(t) for t in trades))
