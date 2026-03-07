# Transaction Log (trades.json)

`trades.json` is the source of truth for your transaction history. It's a JSON array where each entry represents one trade or event that changes your share count.

```json
[
  { "date": "2024-03-15", "symbol": "VTI",  "price": "252.10", "quantity": "10", "type": "buy" },
  { "date": "2024-03-15", "symbol": "VXUS", "price": "55.80",  "quantity": "25", "type": "buy" },
  { "date": "2024-03-15", "symbol": "BND",  "price": "71.50",  "quantity": "20", "type": "buy" }
]
```

All values are strings. The `price` should match the actual closing price on that date — the chart uses `market.csv` for daily valuation, but the Gains tab uses trade prices for cost basis.

## Trade types

The `type` field determines the transaction type. Quantity is always positive — the type controls whether shares are added or removed.

**Buys** — `type` can be omitted (defaults to `"buy"`):
```json
{ "date": "2024-06-01", "symbol": "VTI", "price": "265.00", "quantity": "5" }
```

**Sells** — `type: "sell"`. Optionally specify `lotDate` to match a specific purchase lot for gains tracking:
```json
{ "date": "2024-09-15", "symbol": "VTI", "price": "280.00", "quantity": "3", "type": "sell", "lotDate": "2024-03-15" }
```

**Dividend reinvestment (DRIP)** — `type: "drip"` marks it as organic income rather than external capital, so it doesn't inflate your return calculations:
```json
{ "date": "2024-09-20", "symbol": "VTI", "price": "278.50", "quantity": "0.12", "type": "drip" }
```

**Charitable donations** — `type: "donate"` tracks donated shares separately in the Gains tab:
```json
{ "date": "2024-12-01", "symbol": "VTI", "price": "290.00", "quantity": "2", "type": "donate" }
```

You can also add a `note` field to any trade for your own reference — it's displayed in the Trades tab but doesn't affect calculations.

## Tips

- Enter trades in chronological order (the app sorts them, but it's easier to read)
- Once the server is running, you can edit trades through the Trades tab in the browser, which saves back to the server via `POST /api/trades`

## Importing from Charles Schwab

If you have existing transaction history in Charles Schwab, `utils/importers/import_schwab.py` can convert Schwab's JSON exports to the `trades.json` format. See [Importing from Charles Schwab](setup.md#importing-from-charles-schwab) in the setup guide.
