# Retirement Accounts

Employer-sponsored accounts (401k, 403b, HSA) don't offer daily API access to their balances. You log in every few weeks, note the current value, and that's your data. Stonks fills in the gaps using a proxy-based interpolation model: you provide periodic ground-truth values, and the app estimates daily values by tracking how a market proxy (like VTI) moved in between.

## The problem

Your 401k is worth $12,500 on January 1. You check again on April 1 and it's $12,100. But for the chart to show smooth daily values — and for the Analysis tab to include your 401k in exposure calculations — the app needs a value for every market day in between.

A naive approach would be linear interpolation: draw a straight line from $12,500 to $12,100. But markets don't move in straight lines. If the market crashed 10% in February and recovered by April, a linear interpolation would miss that entirely.

## The proxy model

Instead, Stonks tracks a **market proxy** — a ticker whose daily price is known from `market.csv`. For a total-market target-date fund, VTI is a reasonable proxy. The assumption: your 401k's daily fluctuations roughly follow the proxy.

### Configuration

```json
{
  "accounts": [{ "name": "401k", "proxy": "VTI" }],
  "values": [
    { "date": "2025-01-01", "account": "401k", "value": "12500" },
    { "date": "2025-04-01", "account": "401k", "value": "12100" },
    { "date": "2025-07-01", "account": "401k", "value": "15250" }
  ],
  "contributions": [
    { "date": "2025-01-01", "account": "401k", "amount": "12500" },
    { "date": "2025-04-01", "account": "401k", "amount": "1250" },
    { "date": "2025-07-01", "account": "401k", "amount": "1250" }
  ]
}
```

- **`proxy`**: the ticker to track. Defaults to VTI if omitted.
- **`values`**: ground-truth snapshots. You add these when you check your actual balance.
- **`contributions`**: external capital additions (payroll deductions, employer matches). These are important for accurate interpolation — see below.

### The formula

On any given market day, the interpolated value is:

```
value_today = anchor_value × (proxy_price_today / proxy_price_at_anchor)
```

The **anchor** is the most recent ground truth or contribution adjustment. Each time a new ground truth arrives, it replaces the anchor entirely — this corrects any drift between the proxy and the actual account performance.

### Worked example

Given:
- Ground truth: $12,500 on 2025-01-01
- VTI price on 2025-01-01: $285.77
- VTI price on 2025-02-14: $298.20

Interpolated value on 2025-02-14:

```
$12,500 × (298.20 / 285.77) = $12,500 × 1.0435 = $13,044
```

The 401k is estimated at $13,044, reflecting VTI's 4.35% gain over that period.

When the next ground truth arrives ($12,100 on 2025-04-01), the anchor resets. The proxy-based estimate gets corrected to the real value, and future interpolation starts from this new anchor.

## Handling contributions

Without contribution tracking, the model breaks down between ground truths. Suppose you contribute $1,250 on April 1. The ground truth on July 1 is $15,250. If the model doesn't know about the April contribution, it would attribute the entire increase from $12,100 to $15,250 to market growth — overstating the proxy ratio.

Contributions solve this by adjusting the anchor mid-stream:

1. Scale the current anchor value to today's proxy price
2. Add the contribution amount
3. Set a new anchor at today's proxy price

```
On 2025-04-01 (contribution day):
  scaled_value = 12,100 × (proxy_apr1 / proxy_apr1) = $12,100  (same day as GT, ratio is 1)
  new_anchor   = $12,100 + $1,250 = $13,350
  new_base_price = proxy_apr1

On 2025-05-15:
  value = $13,350 × (proxy_may15 / proxy_apr1)
```

This way, the $1,250 contribution is treated as new capital, not market growth.

### Contribution timing

Contributions between two ground truths are applied incrementally. But contributions on or before the most recent ground truth date are skipped — their effect is already baked into the ground truth value.

## How values appear in the app

Once interpolated, retirement account values are treated like any other symbol:

- **Overview tab**: included in the stacked area chart. Order controlled by `symbolOrder` in `config.json` (retirement accounts are typically placed at the bottom of the stack).
- **Analysis tab**: included in exposure calculations via fractional allocations (see [Exposure Tracking](exposure.md)). A 401k in a target-date fund can be split across Domestic, International, and Bond categories.
- **History tab**: shows the interpolated daily value. Ground-truth cells are editable — click to update the value, which writes back to `retirement.json` via the server.
- **Gains tab**: return metrics (TWR and XIRR) are computed separately for the brokerage portfolio and each retirement account, using contributions as cash flows.

## Adding a new retirement account

1. Add the account definition to `retirement.json`:
   ```json
   { "name": "HSA", "proxy": "VTI" }
   ```

2. Add at least one ground-truth value:
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
