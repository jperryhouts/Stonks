# Retirement Accounts

Employer-sponsored accounts (401k, 403b, HSA) don't offer daily API access to their balances. Stonks fills in the gaps using a proxy-based interpolation model: the app estimates daily values by tracking how a market proxy (like VTI) moves over time. You record your contributions (payroll deductions, employer matches), and the app builds daily values by accumulating them and scaling with the proxy. Periodic ground-truth balance snapshots can optionally correct any drift between the proxy and your account's actual performance.

## The problem

For the chart to show smooth daily values — and for the Analysis tab to include your 401k in exposure calculations — the app needs a value for every market day, not just the handful of dates where you logged in and checked your balance.

A naive approach would be linear interpolation: draw a straight line between known values. But markets don't move in straight lines. If the market crashed 10% in February and recovered by April, linear interpolation would miss that entirely.

## The proxy model

Instead, Stonks tracks a **market proxy** — a ticker whose daily price is known from `market.csv`. For a total-market target-date fund, VTI is a reasonable proxy. The assumption: your 401k's daily fluctuations roughly follow the proxy.

### Configuration

```json
{
  "accounts": [{ "name": "401k", "proxy": "VTI" }],
  "contributions": [
    { "date": "2024-01-01", "account": "401k", "amount": "10000" },
    { "date": "2024-04-01", "account": "401k", "amount": "1250" },
    { "date": "2024-07-01", "account": "401k", "amount": "1250" },
    { "date": "2025-01-01", "account": "401k", "amount": "1250" },
    { "date": "2025-04-01", "account": "401k", "amount": "1250" },
    { "date": "2025-07-01", "account": "401k", "amount": "1250" }
  ],
  "values": [
    { "date": "2025-01-01", "account": "401k", "value": "12500" },
    { "date": "2025-04-01", "account": "401k", "value": "12100" },
    { "date": "2025-07-01", "account": "401k", "value": "15250" }
  ]
}
```

Each contribution represents capital entering the account. The app starts the account at $0 on the first contribution date and builds daily values from there — accumulating deposits and scaling with the proxy. Ground-truth values are optional snapshots of your actual balance; when one arrives, it corrects any drift between the proxy estimate and reality.

- **`proxy`**: the ticker to track. Defaults to VTI if omitted.
- **`contributions`**: the primary way to record account value. Each entry represents capital entering the account (payroll deductions, employer matches). The app builds daily values by accumulating contributions and scaling with the proxy. Also required for accurate return metrics (TWR/XIRR) on the Analysis tab — without them, the app can't distinguish investment growth from deposited capital.
- **`values`**: optional balance snapshots that pin the estimate to reality. Add one whenever you check your actual balance. Each snapshot corrects drift between the proxy and your account's real performance.

### The formula

On any given market day, the interpolated value is:

```
value_today = anchor_value × (proxy_price_today / proxy_price_at_anchor)
```

The **anchor** consists of two values: `activeVal` (the base dollar amount) and `basePrice` (the proxy price at anchor time).

**Contributions set the anchor.** The first contribution initializes the account: `activeVal` = contribution amount, `basePrice` = proxy price on that date. Each subsequent contribution scales the existing value to the current proxy price, adds the contribution, and sets a new anchor. Between contributions, the value moves with the proxy.

**Ground truths reset the anchor.** When a ground-truth value arrives, it replaces the anchor entirely — `activeVal` becomes the ground-truth value, `basePrice` becomes the proxy price on that date. This corrects any accumulated drift between the proxy and actual account performance.

An account with only contributions will be tracked purely via proxy scaling — the daily chart reflects when capital entered and how the market moved. Adding periodic ground truths improves accuracy by snapping the estimate to your real balance, but they aren't required to get a meaningful chart.

### Worked example

**Contributions only:** Given contributions of $10,000 on 2024-01-01 and $1,250 on 2024-04-01, with VTI at $220.00 and $230.00 on those dates:

```
After first contribution:
  anchor = ($10,000, VTI $220.00)

On 2024-04-01 (before adding contribution):
  value = $10,000 × (230.00 / 220.00) = $10,454

After second contribution:
  anchor = ($10,454 + $1,250, VTI $230.00) = ($11,704, $230.00)

On 2024-06-15 with VTI at $235.00:
  value = $11,704 × (235.00 / 230.00) = $11,958
```

The account started at $10,000, grew with VTI, received another $1,250, and continued tracking the proxy.

**Ground-truth correction:** On 2025-01-01, a ground-truth snapshot shows the actual balance is $12,500 (VTI at $285.77). The anchor resets:

```
anchor = ($12,500, VTI $285.77)

On 2025-02-14 with VTI at $298.20:
  value = $12,500 × (298.20 / 285.77) = $13,044
```

The ground truth corrected any drift accumulated over the prior year. Future interpolation starts from this new anchor.

## Return metrics

The Analysis tab computes TWR and XIRR for each retirement account. Each contribution is converted to a synthetic "buy" trade (quantity 1, price = contribution amount) and fed into these calculations. This tells the returns engine how much external capital entered the account and when.

Without contributions, the app would treat the entire account value as investment return — if your 401k is worth $50,000 but you contributed $40,000 of that, XIRR needs to know about the $40,000 to report the correct 25% return instead of treating it as infinite return on zero investment.

## How values appear in the app

Once interpolated, retirement account values are treated like any other symbol:

- **Overview tab**: included in the stacked area chart. Order controlled by `symbolOrder` in `config.json` (retirement accounts are typically placed at the bottom of the stack).
- **Analysis tab**: included in exposure calculations via fractional allocations (see [Exposure Tracking](exposure.md)). A 401k in a target-date fund can be split across Domestic, International, and Bond categories. TWR and XIRR return metrics are also computed here — contributions are the cash flows (see [Return metrics](#return-metrics)).
- **History tab**: shows the interpolated daily value. Ground-truth cells are editable — double-click to update the value (long-press on mobile), which writes back to `retirement.json` via the server.
- **Gains tab**: shows capital gains (realized/unrealized) for brokerage symbols. Retirement accounts don't have individual trade lots, so they don't appear here.

## Adding a new retirement account

1. Add the account definition to `retirement.json`:
   ```json
   { "name": "HSA", "proxy": "VTI" }
   ```

2. Add your contribution history — this is enough to start tracking. The account bootstraps from zero at the first contribution and tracks value via the proxy:
   ```json
   { "date": "2024-01-01", "account": "HSA", "amount": "2000" }
   ```

   Optionally add a ground-truth balance to correct proxy drift:
   ```json
   { "date": "2025-01-01", "account": "HSA", "value": "5000" }
   ```

3. Add allocation entries to `config.json` so the account appears in the Analysis tab:
   ```json
   { "symbol": "HSA", "category": "Domestic (ex-NVDA)", "fraction": "1.0" }
   ```

4. Optionally add it to `symbolOrder` to control its position in the chart stack.

## Choosing a proxy

The proxy should track the general behavior of your account's investments. Some guidelines:

- **Target-date or total-market fund**: VTI is a good default
- **Bond-heavy allocation**: consider BND or a blended approach
- **International-heavy**: VXUS might be more appropriate

The proxy doesn't need to match exactly — it just needs to capture the broad direction. Ground-truth values correct any drift periodically.
