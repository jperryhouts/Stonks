# JSON File Reference

Complete field-by-field reference for all data files used by the app.

- [`trades.json`](#tradesjson) — transaction log
- [`retirement.json`](#retirementjson) — retirement account definitions, contributions, and ground-truth balances
- [`assets.json`](#assetsjson) — deterministic assets (mortgage equity, I-bonds)
- [`config.json`](#configjson) — display, color, exposure, and rebalancing configuration

---

## `trades.json`

Source of truth for your transaction history. Top-level structure: an array of trade objects.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `date` | string | yes | — | `YYYY-MM-DD` |
| `symbol` | string | yes | — | Ticker symbol (uppercase) |
| `price` | string | yes | — | Price per share; used for cost basis in the Performance tab |
| `quantity` | string | yes | — | Share count; always positive — direction set by `type` |
| `type` | string | no | `"buy"` | Transaction type: `"buy"`, `"sell"`, `"drip"`, or `"donate"` |
| `lotDate` | string | no | — | Sells only: `YYYY-MM-DD` of the purchase lot to match. FIFO order is used when omitted |
| `note` | string | no | — | Free-text note shown in the Trades sub-tab; no effect on calculations |

**Type semantics:**

- `buy` — adds shares; the default when `type` is omitted
- `sell` — removes shares; FIFO lot matching unless `lotDate` specifies a particular purchase lot
- `drip` — adds shares as organic income (dividend reinvestment); excluded from XIRR external-capital flows so it doesn't inflate return metrics
- `donate` — removes shares; tracked separately in the Performance tab's Donations table

**Example showing all four types:**

```json
[
  { "date": "2024-03-15", "symbol": "VTI",  "price": "252.10", "quantity": "10", "type": "buy" },
  { "date": "2024-06-01", "symbol": "VTI",  "price": "265.00", "quantity": "5" },
  { "date": "2024-09-15", "symbol": "VTI",  "price": "280.00", "quantity": "3",    "type": "sell",   "lotDate": "2024-03-15" },
  { "date": "2024-09-20", "symbol": "VTI",  "price": "278.50", "quantity": "0.12", "type": "drip",   "note": "Q3 dividend" },
  { "date": "2024-12-01", "symbol": "VTI",  "price": "290.00", "quantity": "2",    "type": "donate" }
]
```

---

## `retirement.json`

Tracks employer-sponsored accounts (401k, 403b, HSA) that don't offer daily price feeds. Top-level structure: an object with three keys.

### `accounts[]` — required

Array of account definitions.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | yes | — | Account identifier; must match the `account` field in `contributions` and `values` entries |
| `proxy` | string | no | `"VTI"` | Exchange-listed ETF ticker whose price movements scale daily estimates. Mutual fund tickers (FXAIX, VTSAX) are not supported — use an equivalent ETF instead |

### `contributions[]` — optional

Records of capital entering the account. Required for accurate return metrics (TWR/XIRR) on the Performance tab.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `date` | string | yes | — | `YYYY-MM-DD` |
| `account` | string | yes | — | Must match a `name` in `accounts` |
| `amount` | string | yes | — | Capital entering the account (payroll deductions, employer matches, etc.) |

### `values[]` — optional

Ground-truth balance snapshots that correct drift between the proxy estimate and actual account performance.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `date` | string | yes | — | `YYYY-MM-DD` |
| `account` | string | yes | — | Must match a `name` in `accounts` |
| `value` | string | yes | — | Actual account balance on this date |

> **Note:** Each `values` entry resets the interpolation anchor — all future daily estimates start from this balance. Add a snapshot periodically (e.g. after checking your account online) to improve accuracy. The History tab's inline double-click edit writes to this array.

**Example with two accounts:**

```json
{
  "accounts": [
    { "name": "401k", "proxy": "VTI" },
    { "name": "HSA",  "proxy": "VTI" }
  ],
  "contributions": [
    { "date": "2024-01-01", "account": "401k", "amount": "10000" },
    { "date": "2024-04-01", "account": "401k", "amount": "1250" },
    { "date": "2024-01-01", "account": "HSA",  "amount": "2000" }
  ],
  "values": [
    { "date": "2025-01-01", "account": "401k", "value": "12500" },
    { "date": "2025-01-01", "account": "HSA",  "value": "3800" }
  ]
}
```

---

## `assets.json`

Deterministic assets whose values are computed from a formula rather than market prices. Top-level structure: an array of asset objects. Each object must have `type` and `name`.

### Mortgage (`type: "mortgage"`)

Tracks home equity — the home's value minus the remaining loan balance — using an amortization schedule.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Display name shown in the chart and History tab |
| `purchaseDate` | string | yes | `YYYY-MM-DD` of loan origination |
| `homeValue` | number | yes | Home purchase price (assumed constant — does not account for appreciation) |
| `downPayment` | number | yes | Down payment amount |
| `loanTermYears` | number | yes | Loan term in years (e.g. `30`) |
| `annualRate` | number | yes | Annual interest rate as a decimal (e.g. `0.0675` for 6.75%) |
| `extraPayments` | array | no | `{ "date": "YYYY-MM-DD", "amount": <number> }` entries for additional principal payments; switches the model to month-by-month simulation |

### I-bond (`type: "ibond"`)

Tracks Series I savings bond value using the Treasury's composite rate formula.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Display name |
| `purchaseDate` | string | yes | `YYYY-MM-DD` |
| `purchaseValue` | number | yes | Initial investment; rounded to $25 units internally |
| `fixedRate` | number | yes | Fixed rate as a decimal (e.g. `0.013` for 1.3%); set at purchase and never changes |
| `rates` | array | yes | `{ "setDate": "YYYY-MM-DD", "semiannualInflation": <number> }` entries. Add a new entry each May and November when the Treasury publishes new rates |

> **Composite rate formula:** `fixedRate + 2×semiannualInflation + fixedRate×semiannualInflation`. Values accrue in $25 units with penny rounding per 6-month period, matching TreasuryDirect's calculation.

**Example:**

```json
[
  {
    "type": "mortgage",
    "name": "Home Equity",
    "purchaseDate": "2024-06-15",
    "homeValue": 200000,
    "downPayment": 10000,
    "loanTermYears": 30,
    "annualRate": 0.0675,
    "extraPayments": [
      { "date": "2025-01-15", "amount": 5000 }
    ]
  },
  {
    "type": "ibond",
    "name": "I-Bond",
    "purchaseDate": "2024-01-01",
    "purchaseValue": 5000,
    "fixedRate": 0.013,
    "rates": [
      { "setDate": "2024-01-01", "semiannualInflation": 0.0197 },
      { "setDate": "2024-07-01", "semiannualInflation": 0.0153 }
    ]
  }
]
```

---

## `config.json`

Unified configuration file. Top-level structure: an object; all fields are optional.

### `symbolOrder`

`string[]` — Symbols listed here are pushed to the bottom of the stacked area chart (rendered first / visually behind other symbols). Useful for stable assets like home equity or retirement accounts.

```json
"symbolOrder": ["Home Equity", "401k", "I-Bond"]
```

### `chartColors`

`array` — Chart color palette; cycles when there are more symbols than entries. Each entry is either:

- A color string: `"#3b82f6"`, `"rgb(59, 130, 246)"`, `"rgba(59, 130, 246, 0.55)"` — fill gets 0.55 alpha applied automatically when a plain string is used
- An object with explicit fill and stroke: `{ "fill": "rgba(59, 130, 246, 0.55)", "stroke": "#3b82f6" }`

```json
"chartColors": [
  "rgb(239, 68, 68)",
  { "fill": "rgba(59, 130, 246, 0.55)", "stroke": "#3b82f6" }
]
```

> **Backwards compatibility:** The old key `colors` is still accepted.

### `capitalGains`

Object controlling the Performance tab's lot-matching behavior.

| Field | Valid values | Description |
|---|---|---|
| `defaultMethod` | `"FIFO"` | Lot-matching method for gains computation. Only FIFO is supported. Individual sells can override per-lot via `lotDate` in `trades.json` |

> **Backwards compatibility:** The old key `method` is still accepted.

### `exposure`

Object with three sub-keys controlling the Allocation tab.

#### `exposure.allocations`

Maps each symbol to its category fractions. Object format (preferred):

```json
"allocations": {
  "VTI":  { "US Stock": 1.0 },
  "VXUS": { "International": 1.0 },
  "VTI":  { "NVDA": 0.067, "Domestic (ex-NVDA)": 0.933 }
}
```

Each symbol maps to an object of `{ category: fraction }` pairs. Fractions for each symbol must sum to 1.0 (±0.01 tolerance). Applies to any symbol type — tickers, retirement accounts, and deterministic assets.

Also accepts a deprecated array format: `[{ "symbol": "VTI", "category": "US Stock", "fraction": 1.0 }]`.

#### `exposure.display`

Array of rows shown in the Allocation tab's category table and donut chart.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Row label |
| `color` | string | yes | Hex, rgb, or rgba color for the donut chart segment and table row |
| `category` | string | no* | Single allocation category this row represents |
| `subcategories` | string | no* | Comma-separated list of categories to aggregate (used for group/summary rows) |
| `indent` | boolean | no | If `true`, row is visually indented — used for sub-rows under group rows |
| `target` | number | no | Rebalancing target percentage (0–100). Only rows with `target` participate in rebalancing; targets should sum to ~100 |

*Exactly one of `category` or `subcategories` must be present per row.

#### `exposure.tradeable`

`string[]` — Symbols the rebalancing calculator may suggest buying or selling. Required if any display row has a `target`.

```json
"tradeable": ["VTI", "VXUS", "BND"]
```

### Complete `config.json` example

```json
{
  "symbolOrder": ["I-Bond", "401k", "Home Equity"],
  "chartColors": [
    "rgb(239, 68, 68)",
    "rgb(59, 130, 246)",
    "rgb(245, 158, 11)"
  ],
  "capitalGains": {
    "defaultMethod": "FIFO"
  },
  "exposure": {
    "allocations": {
      "NVDA": { "NVDA": 1.0 },
      "VTI":  { "NVDA": 0.067, "Domestic (ex-NVDA)": 0.933 },
      "VXUS": { "International": 1.0 },
      "BND":  { "Bonds": 1.0 },
      "401k": { "NVDA": 0.05025, "Domestic (ex-NVDA)": 0.69975, "International": 0.25 },
      "I-Bond": { "Bonds": 1.0 },
      "Home Equity": { "Real Estate": 1.0 }
    },
    "display": [
      { "name": "Domestic Stock",      "color": "#3b82f6", "subcategories": "NVDA, Domestic (ex-NVDA)" },
      { "name": "NVDA",                "color": "#76b900", "indent": true, "category": "NVDA",               "target": 10 },
      { "name": "Non-NVDA",            "color": "#6366f1", "indent": true, "category": "Domestic (ex-NVDA)", "target": 45 },
      { "name": "International Stock", "color": "#f59e0b", "category": "International",                      "target": 25 },
      { "name": "Bonds",               "color": "#14b8a6", "category": "Bonds",                              "target": 20 },
      { "name": "Real Estate",         "color": "#a78bfa", "category": "Real Estate" }
    ],
    "tradeable": ["NVDA", "VTI", "VXUS", "BND"]
  }
}
```
