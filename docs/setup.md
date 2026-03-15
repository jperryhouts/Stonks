# Setup Guide

This walks you through setting up the app with your own portfolio data.

## Choose your path

**Docker** (recommended): only Docker and Docker Compose required — no local Python or Node.js installation needed. A price-fetching container keeps market data current automatically during market hours.

**Local**: requires Node.js (for the web server) and Python 3.10+ with `yfinance` (for price fetching). Prices stay current with a daily python fetcher script.

Both paths use the same data files — you can start local and switch to Docker later.

## Start the app with demo data

The repo ships with demo data in `demo-data/`. Copy it to get a working app immediately:

```bash
cp -r demo-data/ data/
```

Then start the server:

**Docker:**
```bash
cp .env.example .env
# Edit .env if needed (DATA_DIR, PORT, AUTH_PASS)
docker compose up -d
```

**Local:**
```bash
DATA_DIR=./data node app/serve.js
```

Open http://localhost:8000.

> **What you get at this point:** A fully functional app with the demo portfolio — all four tabs work. Explore the interface before touching any data file. The next steps replace the demo content with your real holdings.

> **Minimum setup:** Steps 1 and 2 are all you need to see your real portfolio. The Overview, History, and Performance tabs work with just `trades.json` and `market.csv`. Steps 3–5 add the Allocation tab exposure breakdown, rebalancing calculator, retirement accounts, and formula-driven assets.

## The Settings tab

Once the server is running, the **Settings** tab lets you edit `config.json`,
`assets.json`, and `retirement.json` directly in the browser. Each section
validates your JSON before saving and updates the file on disk. You can use
the browser editor or edit the files directly — they're the same thing.

See the [JSON File Reference](json-reference.md) for a complete field listing of all data files.

---

## Step 1: Replace the sample trades

Edit `data/trades.json` with your actual transaction history. Each trade has a date, symbol, price, quantity, and type:

```json
[
  { "date": "2024-03-15", "symbol": "VTI",  "price": "252.10", "quantity": "10", "type": "buy" },
  { "date": "2024-03-15", "symbol": "VXUS", "price": "55.80",  "quantity": "25", "type": "buy" },
  { "date": "2024-03-15", "symbol": "BND",  "price": "71.50",  "quantity": "20", "type": "buy" }
]
```

All values are strings. See [Transaction Log](trades.md) for the full format reference, including sell, DRIP, and donation types.

> **Tip:** The Trades sub-tab (under History) lets you add, edit, and delete trades without touching the JSON. For an initial import of a long history, editing the file directly is usually faster — but once you're set up, the UI is convenient for adding new trades one at a time.

> **Importing from Charles Schwab?** See the [Schwab importer](#importing-from-charles-schwab) section at the bottom of this guide.

> **What you get at this point:** The History tab's Trades sub-tab shows your full transaction history, and the Performance tab shows realized gains. The Overview chart still shows demo prices — the next step fetches market data for your tickers.

---

## Step 2: Update market data for your tickers

The fetcher automatically discovers which tickers to fetch by reading `trades.json` (and `retirement.json` if present). Historical gaps are filled automatically.

**Docker:**
```bash
docker compose restart fetcher
```

Wait about a minute. The fetcher runs on startup, reads your tickers from `trades.json`, fetches current prices, and backfills any historical gaps automatically.

**Local:**
```bash
python3 utils/tickers/fetch_prices.py -d data/
```

The script reads tickers from `trades.json`, fetches prices, and runs a backfill check automatically. Then refresh the browser.


> **Note:** If you add a new ticker later, repeat this step — same commands, no extra flags needed.

> **What you get at this point:** The Overview chart fills in with your portfolio's real price history. Performance tab return metrics now use accurate market data.

---

## Step 3: Configure exposure categories

The Overview, History, and Performance tabs all work without any configuration. But to enable the Allocation tab breakdown and the rebalancing calculator, you need a `config.json` that maps your symbols to categories.

The easiest approach: edit `data/config.json` (copied from the demo) to match your holdings — delete entries you don't need and adjust categories as needed.

> **Browser editor:** Open **Settings → Config** to edit `config.json`
> in the browser. Changes are validated before saving.

At minimum, the `config.json` needs an `exposure` section:

```json
{
  "exposure": {
    "allocations": {
      "VTI":  { "US Stock": 1.0 },
      "VXUS": { "International": 1.0 },
      "BND":  { "Bonds": 1.0 }
    },
    "display": [
      { "name": "US Stock",      "color": "#3b82f6", "category": "US Stock" },
      { "name": "International", "color": "#f59e0b", "category": "International" },
      { "name": "Bonds",         "color": "#14b8a6", "category": "Bonds" }
    ]
  }
}
```

- **`allocations`**: maps each symbol to its categories. Each key is a ticker symbol, and each value is an object mapping category names to fractions. Fractions for a given symbol must sum to 1.0.
- **`display`**: defines the rows shown in the "By Category" table in the Allocation tab's Rebalancing sub-tab. Each entry has a name, color (used in the donut chart), and the category it represents.

This is enough to get started. The Allocation tab's Rebalancing sub-tab will show a donut chart alongside the category breakdown.

### Fractional exposure (optional)

If you hold both an index fund and an individual stock that's a component of that index, you can split the index fund's allocation to reveal the overlap. For example, if you hold NVDA directly and VTI (which is ~6.7% NVDA):

```json
{
  "exposure": {
    "allocations": {
      "NVDA": { "NVDA": 1.0 },
      "VTI":  { "NVDA": 0.067, "US (ex-NVDA)": 0.933 },
      "VXUS": { "International": 1.0 },
      "BND":  { "Bonds": 1.0 }
    },
    "display": [
      { "name": "US Stock",      "color": "#3b82f6", "subcategories": "NVDA, US (ex-NVDA)" },
      { "name": "NVDA",          "color": "#76b900", "indent": true, "category": "NVDA" },
      { "name": "Non-NVDA",      "color": "#6366f1", "indent": true, "category": "US (ex-NVDA)" },
      { "name": "International", "color": "#f59e0b", "category": "International" },
      { "name": "Bonds",         "color": "#14b8a6", "category": "Bonds" }
    ]
  }
}
```

Now VTI is split: 6.7% of its value counts toward NVDA, and the Allocation tab shows your true NVDA concentration across all holdings. See [Fractional Exposure Tracking](exposure.md) for a full walkthrough.

### Rebalancing targets (optional)

To enable the Allocation tab rebalancing calculator, add `target` fields to the display rows you want to rebalance against, and a `tradeable` array listing which symbols can be bought/sold:

```json
{
  "exposure": {
    "allocations": {
      "VTI":  { "US Stock": 1.0 },
      "VXUS": { "International": 1.0 },
      "BND":  { "Bonds": 1.0 }
    },
    "display": [
      { "name": "US Stock",      "color": "#3b82f6", "category": "US Stock",      "target": 60 },
      { "name": "International", "color": "#f59e0b", "category": "International", "target": 25 },
      { "name": "Bonds",         "color": "#14b8a6", "category": "Bonds",         "target": 15 }
    ],
    "tradeable": ["VTI", "VXUS", "BND"]
  }
}
```

Target percentages should sum to 100. Only display rows with a `target` field participate in rebalancing — rows without it (like group/summary rows) are ignored. The `tradeable` array lists symbols the rebalancing calculator is allowed to suggest buying or selling.

### Other config options

```json
{
  "symbolOrder": ["Home Equity", "401k"],
  "capitalGains": { "defaultMethod": "FIFO" },
  "chartColors": [
    { "fill": "rgba(59, 130, 246, 0.55)", "stroke": "#3b82f6" },
    { "fill": "rgba(245, 158, 11, 0.55)", "stroke": "#f59e0b" }
  ]
}
```

- **`symbolOrder`**: symbols listed here are rendered at the bottom of the stacked area chart (visually "behind" other symbols). Useful for pushing stable assets like home equity or retirement accounts to the base of the chart.
- **`capitalGains.defaultMethod`**: `"FIFO"` — default lot matching method for gains tracking. Individual sell trades can also specify a `lotDate` field to select a specific purchase lot by date. See [Transaction Log](trades.md) for details.
- **`chartColors`**: chart color palette. Colors cycle when there are more symbols than entries.

> **What you get at this point:** The Allocation tab's Rebalancing sub-tab shows the donut chart, exposure breakdown, and the rebalancing calculator.

---

## Step 4: Retirement accounts (optional)

If you have employer-sponsored accounts (401k, HSA, 403b) that don't offer daily price feeds, create `data/retirement.json`.

> **Browser editor:** Open **Settings → Retirement** to edit
> `retirement.json` in the browser.

> **Importing Fidelity 401k / HSA contribution history?** See the [Fidelity importer](#importing-from-fidelity) section at the bottom of this guide.

```json
{
  "accounts": [
    { "name": "401k", "proxy": "VTI" }
  ],
  "contributions": [
    { "date": "2023-06-01", "account": "401k", "amount": "10000" },
    { "date": "2023-09-01", "account": "401k", "amount": "5000" },
    { "date": "2024-01-01", "account": "401k", "amount": "5000" },
    { "date": "2024-04-01", "account": "401k", "amount": "5000" }
  ],
  "values": [
    { "date": "2024-01-01", "account": "401k", "value": "25000" }
  ]
}
```

The `contributions` array is the primary way to track a retirement account. Each entry represents capital entering the account (payroll deductions, employer matches). The app starts the account at $0 on the first contribution date and builds daily values by accumulating deposits and scaling with a proxy ticker. Contributions are also required for the Performance tab's return metrics (TWR/XIRR) — without them, the app can't distinguish investment growth from deposited capital.

Ground-truth `values` entries are optional but improve accuracy — they correct drift between the proxy and your account's actual performance. Log in every few weeks and add a new `values` entry to snap the estimate to reality. See [Retirement Accounts](retirement.md) for details.

> **Important:** You also need to add an allocation entry in `config.json` for each retirement account. Without it the account will appear in the Overview and History tabs but will be **excluded from the Allocation tab** and the rebalancing calculator.

```json
"401k": { "US Stock": 1.0 }
```

> **Proxy tickers:** Only exchange-listed ETF tickers work as proxies — mutual fund tickers like `FXAIX` or `VTSAX` are not supported by the price fetcher. Use an equivalent ETF instead (e.g. `SPY` or `VOO` in place of FXAIX, `VTI` in place of VTSAX).

> If you set this up after already running [step 2](#step-2-update-market-data-for-your-tickers), re-run that step to backfill the proxy ticker's price history.

---

## Step 5: Deterministic assets (optional)

For assets with formula-driven values (mortgage equity, I-bonds), create `data/assets.json`.

> **Browser editor:** Open **Settings → Assets** to edit `assets.json`
> in the browser.

```json
[
  {
    "type": "mortgage",
    "name": "Home Equity",
    "purchaseDate": "2024-06-15",
    "homeValue": 200000,
    "downPayment": 10000,
    "loanTermYears": 30,
    "annualRate": 0.0675
  }
]
```

These appear in the chart alongside your other holdings. The rebalancing tool only shows symbols that have entries in `exposure.allocations`, so illiquid assets like home equity are automatically absent from rebalancing even if they appear in the chart.

See [Deterministic Assets](assets.md) for mortgage and I-bond configuration details.

---

## Keeping data current

**Daily prices:** Handled automatically by the Docker fetcher during market hours. For local installs, run the command from [step 2](#step-2-update-market-data-for-your-tickers) at least once a day.

**New trades:** Add them to `trades.json` by hand, or use the Trades sub-tab under History in the browser (which saves back to the server when you click the "Save" button in the UI).

**Retirement values:** Open **Settings → Retirement** to edit
`retirement.json` in the browser, or double-click any retirement account
cell in the History tab to update a ground-truth value inline.

**New tickers:** Add to `trades.json` and add allocation entries to `config.json`. Run `docker compose restart fetcher` (or `python3 utils/tickers/fetch_prices.py -d data/` locally) — the fetcher will backfill price history for the new symbol automatically.

---

## Importing from Charles Schwab

If you have existing transaction history in Charles Schwab, `utils/importers/import_schwab.py` can convert Schwab's JSON exports to the `trades.json` format. It supports two Schwab export types:

- **Brokerage Transaction History** — standard buy/sell/reinvestment transactions from brokerage accounts
- **Equity Awards Center** — RSU vests and ESPP purchases from the Equity Awards section

### Exporting from Schwab

**Brokerage accounts:**
1. Navigate to an account's Transaction History
2. Set the Date Range (up to a four-year window) and click "Search"
3. Click the download icon (top right, next to the printer icon)
4. Save as JSON format

**Equity Awards:**
Download transaction history from the Equity Awards Center in the same way. You can export multiple files (e.g., one per year or one per account type).

### Running the importer

```bash
python3 utils/importers/import_schwab.py /path/to/schwab-export.json > _tmp_trades.json
# Multiple files:
python3 utils/importers/import_schwab.py export1.json export2.json > _tmp_trades.json
```

The script writes converted trades to stdout, sorted in reverse chronological order. Review the output in `_tmp_trades.json`, then manually merge it into your `data/trades.json`.

**What gets imported:**
- Buys → `type: "buy"`
- Sells (including sell-to-cover for tax withholding) → `type: "sell"`
- Dividend reinvestment → `type: "drip"` with note `"reinvested dividend"`
- RSU vests → `type: "buy"` with note indicating the grant ID
- ESPP purchases → `type: "buy"` with note `"ESPP purchase"`

Other transaction types (journal entries, dividends paid as cash, etc.) are skipped.

The script is intentionally simple — it's designed for a one-time historical import, not an ongoing sync. Review the output before merging to catch anything that needs manual adjustment.

> **Historical data gaps:** Schwab exports cover up to a 4-year window. If you've held a security for longer than that, the original purchase won't be in the export. The Performance tab will show "Insufficient shares" warnings for those sells — the realized gain calculation will be incomplete for those specific lots, but the rest of the portfolio data will work correctly.

---

## Importing from Fidelity

If you have a Fidelity 401k or HSA, `utils/importers/import_fidelity.py` can import your contribution history into `retirement.json`. It reads Fidelity's CSV account history exports and upserts contribution records by date.

It supports two Fidelity CSV export formats automatically:

- **401k / workplace accounts** — CSV with `Date` and `Transaction Type` columns; rows where `Transaction Type == "Contributions"` are imported.
- **Brokerage / HSA accounts** — CSV with `Run Date` and `Action` columns; rows where `Action` contains `"CONTR"` are imported.

### Exporting from Fidelity

1. Log in and navigate to the account (401k or HSA)
2. Go to **Activity & Orders** → **History**
3. Set the date range and download as CSV

### Running the importer

```bash
# Import 401k contributions
python3 utils/importers/import_fidelity.py \
    --csv Fidelity_History_for_Account_XXXXX.csv \
    --retirement data/retirement.json \
    --account "401k"

# Import HSA contributions
python3 utils/importers/import_fidelity.py \
    --csv Fidelity_History_for_Account_YYYYY.csv \
    --retirement data/retirement.json \
    --account "HSA"

# Preview changes without writing
python3 utils/importers/import_fidelity.py \
    --csv Fidelity_History_for_Account_XXXXX.csv \
    --retirement data/retirement.json \
    --account "401k" \
    --dry-run
```

The script edits `retirement.json` in-place, adding or updating entries in the `contributions` array. Contributions on the same date are summed before upserting.

**Note:** This importer handles contribution records only — it does not import account balances (the `values` array). The app will bootstrap the account from zero at the first contribution and track value via the proxy, so this is enough to get started. For better accuracy, periodically log ground-truth balances in `retirement.json` or via the History tab — each snapshot corrects any drift between the proxy and your account's real performance.

---

## Troubleshooting

**Chart is empty or shows no data**
- If using Docker: wait a minute after `docker compose up` for the initial backfill to complete, then refresh the page.
- If running locally: run `python3 utils/tickers/fetch_prices.py -d data/` to fetch and backfill price history for your tickers.
- Check that `market.csv` has rows covering dates on or after your first trade. The chart only shows values for days where both a position and a price exist.

**`fetch_prices.py` does nothing or shows an error**
- The fetch script requires Python 3.10+ and `yfinance`. If you're using a virtual environment, make sure to activate it before running.
- If you see a `SyntaxError` mentioning `type | None`, your Python version is too old — 3.10+ is required.
- If you see `"Failed to fetch prices for: FXAIX"` (or another mutual fund ticker), the fetcher doesn't support mutual fund symbols. Change the proxy to an equivalent ETF — e.g. `SPY` or `VOO` instead of `FXAIX`, `VTI` instead of `VTSAX`.

**Retirement account not appearing in the Allocation tab**
- The account needs an allocation entry in `config.json` → `exposure.allocations`. Without it the account is visible in Overview/History but excluded from the Allocation tab. See [Step 3](#step-3-configure-exposure-categories).

**Docker: permission denied errors**
- The web container runs as the UID/GID specified in `.env` (default 1000:1000). Set `UID` and `GID` to match the owner of your data directory (run `id -u` and `id -g` to find your values), then rebuild with `docker compose build web`. Alternatively, run `chown -R 1000:1000 <your-DATA_DIR>` to match the defaults.

**Retirement account values not appearing**
- Ensure the account is defined in `retirement.json`'s `accounts` array and has at least one entry in `values` or `contributions`.
- The proxy ticker (default `VTI`) must have price data in `market.csv` covering the earliest contribution or ground-truth date. If the proxy has no data for that date, interpolation can't start. Re-run the fetcher to backfill.
