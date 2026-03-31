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
"""

import json
import sys
from datetime import datetime


def clean_num(s):
    """Strip $, commas, and whitespace from a numeric string."""
    return s.strip().lstrip("$").replace(",", "") if s else ""


def iso(s):
    """Convert 'MM/DD/YYYY [as of ...]' date string to 'YYYY-MM-DD'."""
    return datetime.strptime(s.strip().split()[0], "%m/%d/%Y").strftime("%Y-%m-%d")


def parse_schwab_data(data, source_label="<unknown>"):
    """Parse a single Schwab data dict and return a list of trade dicts.

    Handles both BrokerageTransactions and Transactions (equity awards) formats.
    Returns an empty list for unrecognized formats (logs a warning to stderr).
    source_label is used only for the warning message (typically the file path).
    """
    trades = []

    if "BrokerageTransactions" in data:
        for t in data["BrokerageTransactions"]:
            action = t["Action"]
            symbol = t["Symbol"].strip()
            if not symbol:
                continue

            if action == "Buy":
                trades.append({
                    "date": iso(t["Date"]),
                    "symbol": symbol,
                    "price": str(round(float(clean_num(t["Price"])), 6)),
                    "quantity": str(float(clean_num(t["Quantity"]))),
                    "type": "buy",
                })

            elif action == "Reinvest Shares":
                trades.append({
                    "date": iso(t["Date"]),
                    "symbol": symbol,
                    "price": str(round(float(clean_num(t["Price"])), 6)),
                    "quantity": str(float(clean_num(t["Quantity"]))),
                    "type": "drip",
                    "note": "reinvested dividend",
                })

            elif action == "Sell":
                trades.append({
                    "date": iso(t["Date"]),
                    "symbol": symbol,
                    "price": str(round(float(clean_num(t["Price"])), 6)),
                    "quantity": str(abs(float(clean_num(t["Quantity"])))),
                    "type": "sell",
                })
            # Journaled Shares and everything else = skip

    elif "Transactions" in data:
        for t in data["Transactions"]:
            action = t["Action"]
            symbol = (t.get("Symbol") or "").strip()
            if not symbol:
                continue
            date = iso(t["Date"])
            details = (t.get("TransactionDetails") or [{}])[0].get("Details", {})

            if action == "Lapse":
                qty = float(clean_num(t["Quantity"]))
                price = float(clean_num(details.get("FairMarketValuePrice", "")))
                trades.append({
                    "date": date,
                    "symbol": symbol,
                    "price": str(round(price, 6)),
                    "quantity": str(qty),
                    "type": "buy",
                    "note": f"RSU vest (grant {details.get('AwardId', '')})",
                })

            elif action == "Deposit" and t.get("Description") == "ESPP":
                qty = float(clean_num(t["Quantity"]))
                price = float(clean_num(details.get("PurchasePrice", "")))
                trades.append({
                    "date": date,
                    "symbol": symbol,
                    "price": str(round(price, 6)),
                    "quantity": str(qty),
                    "type": "buy",
                    "note": "ESPP purchase",
                })

            elif action == "Sale":
                qty = float(clean_num(t["Quantity"]))
                if details.get("SalePrice"):
                    price = float(clean_num(details["SalePrice"]))
                else:
                    price = float(clean_num(t["Amount"])) / qty
                trades.append({
                    "date": date,
                    "symbol": symbol,
                    "price": str(round(price, 6)),
                    "quantity": str(abs(qty)),
                    "type": "sell",
                })
            # Journal, Dividend, Check = skip

    else:
        print(f"Warning: unrecognized format in {source_label}", file=sys.stderr)

    return trades


def main(files=None):
    if files is None:
        files = sys.argv[1:]
    if not files:
        print("At least one Schwab data export file must be specified.")
        sys.exit(1)

    trades = []
    for path in files:
        data = json.load(open(path))
        trades.extend(parse_schwab_data(data, source_label=path))

    trades.sort(
        key=lambda r: (r["date"], r["symbol"], r["type"], r["quantity"]),
        reverse=True,
    )
    print("  " + ",\n  ".join(json.dumps(t) for t in trades))


if __name__ == "__main__":
    main()
